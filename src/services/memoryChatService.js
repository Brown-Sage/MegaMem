const { retrieveMemory } = require('./retrieveService')
const { completeChat } = require('./groqService')
const { buildPrompt } = require('./promptService')
const { extractMemories } = require('./extractionService')
const { detectMemoryConflict } = require('./conflictService')
const { applyMemoryDecision } = require('./memoryService')
const { chunkText, dedupeChunks } = require('../utils/chunker')

const MIN_EXTRACTION_CONFIDENCE = 0.6

const formatConversation = ({ query, answer }) => [
  `User: ${query}`,
  `Assistant: ${answer}`
].join('\n')

const persistExtractedMemories = async ({ conversation, sessionId }) => {
  const chunks = dedupeChunks(chunkText(conversation))
  console.log(`[pipeline] Chunks created: ${chunks.length}`)
  chunks.forEach((c, i) => console.log(`[pipeline]   Chunk ${i + 1} length: ${c.length} chars`))

  const extracted = await extractMemories({ conversation, chunks })
  console.log(`[pipeline] Final merged memories: ${extracted.length}`)
  extracted.forEach((m, i) => console.log(`[pipeline]   ${i + 1}. [${m.type}] (conf=${m.confidence}) ${m.text}`))

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

    try {
      const decision = await detectMemoryConflict({
        memory,
        sessionId
      })

      const applied = await applyMemoryDecision({
        decision,
        sessionId,
        fallbackText: memory.text
      })

      results.push({
        action: applied.action,
        text: memory.text,
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
  const answer = await completeChat(messages)

  const conversation = formatConversation({ query, answer })

  persistExtractedMemories({ conversation, sessionId })
    .then(results => {
      const saved = results.filter(r => r.action === 'create' || r.action === 'update')
      if (saved.length > 0) {
        console.log(`auto-memory: ${saved.length} saved for session ${sessionId}`)
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
