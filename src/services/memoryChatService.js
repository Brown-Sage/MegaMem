const { retrieveMemory } = require('./retrieveService')
const { completeChat } = require('./groqService')
const { buildPrompt } = require('./promptService')
const {
  extractMemories,
  updateRunningSummary,
  scaledMaxMemories,
  EXTRACTION_CHUNK_CHARS,
  EXTRACTION_CHUNK_OVERLAP,
  EXTRACTION_MAX_CHUNKS
} = require('./extractionService')
const { detectMemoryConflict } = require('./conflictService')
const { applyMemoryDecision } = require('./memoryService')
const { chunkText, dedupeChunks } = require('../utils/chunker')
const { parseSessionDate, resolveEventDate } = require('../utils/temporal')
const { computeDedupKey } = require('../utils/dedupKey')
const { embedText } = require('./embedService')
const { recordWrite, checkRecentDuplicate, getRecentCandidates } = require('../utils/recentWrites')
const { resolveSessionIds, targetSessionId } = require('../utils/sessionId')
const { child } = require('../utils/log')

const log = child('chat')

const MIN_EXTRACTION_CONFIDENCE = 0.6

const formatConversation = ({ query, answer }) => [
  `User: ${query}`,
  `Assistant: ${answer}`
].join('\n')

const layersForPersist = ({ sessionId, userId, workspaceId }) => {
  if (sessionId) return resolveSessionIds(sessionId)
  if (userId && workspaceId) {
    const ids = [...new Set([userId, workspaceId])]
    return { userId, workspaceId, explicit: null, ids }
  }
  return resolveSessionIds(undefined)
}

// Extraction chunking is intentionally tighter than the generic defaults so
// the model emits discrete facts instead of session-wide summaries.
const extractionChunks = (conversation) => dedupeChunks(chunkText(conversation, {
  maxChars: EXTRACTION_CHUNK_CHARS,
  overlapChars: EXTRACTION_CHUNK_OVERLAP,
  maxChunks: EXTRACTION_MAX_CHUNKS
}))

const persistExtractedMemories = async ({
  conversation,
  sessionId,
  userId,
  workspaceId,
  scope,
  actor = 'mcp'
}) => {
  const layers = layersForPersist({ sessionId, userId, workspaceId })
  const chunks = extractionChunks(conversation)
  const sessionDate = parseSessionDate(conversation)

  log.info({ chunks: chunks.length, hasSessionDate: !!sessionDate, actor }, 'pipeline started')

  // Rolling context: each later chunk sees a running summary plus the tail of
  // the previous chunk, so pronouns resolve and facts stay consistent.
  let runningSummary = ''
  let prevTail = ''
  const extracted = []

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]
    try {
      const context = runningSummary || prevTail
        ? [runningSummary && `Summary so far:\n${runningSummary}`, prevTail && `End of previous segment:\n...${prevTail}`]
          .filter(Boolean)
          .join('\n\n')
        : undefined

      const chunkMemories = await extractMemories({
        conversation: chunk,
        maxMemories: scaledMaxMemories(chunk.length),
        context
      })

      extracted.push(...chunkMemories.map((m) => ({
        ...m,
        eventAt: m.eventAt || resolveEventDate(m.text, sessionDate)
      })))

      runningSummary = await updateRunningSummary(runningSummary, chunk)
      prevTail = chunk.slice(-800)
    } catch (error) {
      log.warn({ err: error.message, chunk: i + 1 }, 'chunk pipeline failed')
    }
  }

  log.info({ count: extracted.length }, 'extraction merged')
  log.debug({ memories: extracted.map(m => ({ type: m.type, confidence: m.confidence, text: m.text })) }, 'merged memory detail')

  const results = []
  const seenDedupKeys = new Set()

  for (const memory of extracted) {
    if (memory.confidence < MIN_EXTRACTION_CONFIDENCE) {
      results.push({
        action: 'skip',
        text: memory.text,
        reason: `Extraction confidence ${memory.confidence} below ${MIN_EXTRACTION_CONFIDENCE}.`
      })
      continue
    }

    const targetId = targetSessionId(layers, memory.type, scope)
    const dedupKey = computeDedupKey(memory.text)

    if (seenDedupKeys.has(dedupKey)) {
      results.push({ action: 'skip', text: memory.text, reason: 'Duplicate within same extraction batch.' })
      continue
    }
    seenDedupKeys.add(dedupKey)

    // Layer 2 — recent-writes race check before spending LLM tokens.
    let embedding = null
    try {
      embedding = await embedText(memory.text)
    } catch (error) {
      log.warn({ err: error.message }, 'embed failed for extracted fact')
    }

    if (embedding) {
      const recent = checkRecentDuplicate({ sessionId: targetId, dedupKey, embedding })
      if (recent.duplicate) {
        results.push({ action: 'skip', text: memory.text, reason: recent.reason })
        continue
      }
    }

    try {
      const decision = await detectMemoryConflict({
        memory,
        sessionId: targetId,
        queryEmbedding: embedding,
        extraCandidates: getRecentCandidates(targetId)
      })

      const applied = await applyMemoryDecision({
        decision,
        sessionId: targetId,
        fallbackText: memory.text,
        type: memory.type,
        eventAt: memory.eventAt,
        importance: memory.importance,
        confidence: memory.confidence,
        actor
      })

      if (applied.action === 'create' || applied.action === 'update') {
        recordWrite({
          sessionId: targetId,
          memoryId: applied.memory?._id?.toString() || null,
          dedupKey,
          embedding
        })
      }

      results.push({
        action: applied.action,
        text: memory.text,
        type: memory.type,
        sessionId: targetId,
        memoryId: applied.memory?._id?.toString() || null,
        reason: applied.reason
      })
    } catch (error) {
      log.warn({ err: error.message }, 'memory persistence failed')
      results.push({
        action: 'error',
        text: memory.text,
        reason: error.message
      })
    }
  }

  return results
}

const chatWithMemory = async ({ query, sessionId, topK = 5 }) => {
  const memories = await retrieveMemory(query, sessionId, topK)
  const messages = buildPrompt({ query, memories })
  const answer = await completeChat(messages, { maxRetries: 1, timeoutMs: 6000 })

  const conversation = formatConversation({ query, answer })

  persistExtractedMemories({ conversation, sessionId })
    .then(results => {
      const saved = results.filter(r => r.action === 'create' || r.action === 'update' || r.action === 'delete')
      if (saved.length > 0) {
        log.info({ saved: saved.length, sessionId }, 'auto-memory persisted')
      }
    })
    .catch(error => {
      log.error({ err: error.message }, 'auto-memory pipeline failed')
    })

  return {
    answer,
    memories
  }
}

module.exports = { chatWithMemory, persistExtractedMemories, formatConversation }
