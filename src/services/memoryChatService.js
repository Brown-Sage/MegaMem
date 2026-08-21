const { retrieveMemory } = require('./retrieveService')
const { completeChat } = require('./groqService')
const { buildPrompt } = require('./promptService')
const { extractMemories } = require('./extractionService')
const { detectMemoryConflict } = require('./conflictService')
const { applyMemoryDecision } = require('./memoryService')
const { chunkText, dedupeChunks } = require('../utils/chunker')
const { resolveSessionIds, targetSessionId } = require('../utils/sessionId')

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

const persistExtractedMemories = async ({
  conversation,
  sessionId,
  userId,
  workspaceId,
  scope
}) => {
  const layers = layersForPersist({ sessionId, userId, workspaceId })
  const chunks = dedupeChunks(chunkText(conversation))
  console.error(`[pipeline] Chunks created: ${chunks.length}`)
  chunks.forEach((c, i) => console.error(`[pipeline]   Chunk ${i + 1} length: ${c.length} chars`))

  const extracted = await extractMemories({ conversation, chunks })
  console.error(`[pipeline] Final merged memories: ${extracted.length}`)
  extracted.forEach((m, i) => console.error(`[pipeline]   ${i + 1}. [${m.type}] (conf=${m.confidence}) ${m.text}`))

  const results = []

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

    try {
      const decision = await detectMemoryConflict({
        memory,
        sessionId: targetId
      })

      const applied = await applyMemoryDecision({
        decision,
        sessionId: targetId,
        fallbackText: memory.text,
        type: memory.type
      })

      results.push({
        action: applied.action,
        text: memory.text,
        type: memory.type,
        sessionId: targetId,
        memoryId: applied.memory?._id?.toString() || null,
        reason: applied.reason
      })
    } catch (error) {
      console.error('memory persistence failed:', error.message)
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
      const saved = results.filter(r => r.action === 'create' || r.action === 'update')
      if (saved.length > 0) {
        console.error(`auto-memory: ${saved.length} saved for session ${sessionId}`)
      }
    })
    .catch(error => {
      console.error('auto-memory pipeline failed:', error.message)
    })

  return {
    answer,
    memories
  }
}

module.exports = { chatWithMemory, persistExtractedMemories, formatConversation }
