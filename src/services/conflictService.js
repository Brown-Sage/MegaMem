const Memory = require('../models/Memory')
const { embedText } = require('./embedService')
const { completeChat } = require('./groqService')
const { parseJsonObject } = require('../utils/json')

const CONFLICT_ACTIONS = ['create', 'update', 'skip']

const findSimilarMemories = async ({ text, sessionId, topK = 5, minScore = 0.65 }) => {
  const queryEmbedding = await embedText(text)

  const results = await Memory.aggregate([
    {
      $vectorSearch: {
        index: 'vector_index',
        path: 'embedding',
        queryVector: queryEmbedding,
        numCandidates: 50,
        limit: topK,
        filter: { sessionId }
      }
    },
    {
      $project: {
        _id: 1,
        text: 1,
        score: { $meta: 'vectorSearchScore' }
      }
    }
  ])

  return results
    .filter(memory => typeof memory.score !== 'number' || memory.score >= minScore)
    .map(memory => ({
      id: memory._id.toString(),
      text: memory.text,
      score: memory.score
    }))
}

const buildConflictMessages = ({ newMemory, candidates }) => [
  {
    role: 'system',
    content: [
      'You decide how a memory system should handle a new memory candidate.',
      'Compare the new memory with existing similar memories.',
      'Return only valid JSON. Do not include markdown.',
      '',
      'Actions:',
      '- create: the new memory is meaningfully new.',
      '- update: the new memory replaces or corrects an existing memory about the same subject.',
      '- skip: the new memory is a duplicate or adds no useful new information.'
    ].join('\n')
  },
  {
    role: 'user',
    content: [
      'New memory:',
      JSON.stringify(newMemory),
      '',
      'Existing similar memories:',
      JSON.stringify(candidates),
      '',
      'Use this JSON shape exactly:',
      '{',
      '  "action": "create|update|skip",',
      '  "targetMemoryId": "existing memory id, or null",',
      '  "memoryText": "final memory text to store, or null",',
      '  "confidence": 0.8,',
      '  "reason": "short explanation"',
      '}',
      '',
      'Rules:',
      '- If the new memory contradicts an old memory, choose update and use the new fact as memoryText.',
      '- If the new memory is a duplicate, choose skip and target the duplicate.',
      '- If no existing memory is about the same subject, choose create.'
    ].join('\n')
  }
]

const normalizeDecision = (decision) => {
  const action = CONFLICT_ACTIONS.includes(decision.action)
    ? decision.action
    : 'create'

  return {
    action,
    targetMemoryId: typeof decision.targetMemoryId === 'string'
      ? decision.targetMemoryId
      : null,
    memoryText: typeof decision.memoryText === 'string' && decision.memoryText.trim()
      ? decision.memoryText.trim()
      : null,
    confidence: typeof decision.confidence === 'number'
      ? Math.min(1, Math.max(0, decision.confidence))
      : 0.7,
    reason: typeof decision.reason === 'string' ? decision.reason.trim() : ''
  }
}

const detectMemoryConflict = async ({ memory, sessionId, topK = 5, minScore = 0.65 }) => {
  const text = typeof memory === 'string' ? memory : memory?.text

  if (!text || typeof text !== 'string' || !text.trim()) {
    throw new Error('detectMemoryConflict requires a memory text')
  }

  const candidates = await findSimilarMemories({
    text: text.trim(),
    sessionId,
    topK,
    minScore
  })

  if (candidates.length === 0) {
    return {
      action: 'create',
      targetMemoryId: null,
      memoryText: text.trim(),
      confidence: 1,
      reason: 'No similar memories found.',
      candidates
    }
  }

  const content = await completeChat(buildConflictMessages({
    newMemory: typeof memory === 'string' ? { text: text.trim() } : memory,
    candidates
  }), {
    temperature: 0,
    maxTokens: 500
  })

  return {
    ...normalizeDecision(parseJsonObject(content, 'Memory conflict detection')),
    candidates
  }
}

module.exports = {
  detectMemoryConflict,
  findSimilarMemories,
  buildConflictMessages
}
