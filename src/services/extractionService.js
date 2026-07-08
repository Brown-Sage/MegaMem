const { completeChat } = require('./groqService')
const { parseJsonObject } = require('../utils/json')

const MEMORY_TYPES = [
  'preference',
  'fact',
  'decision',
  'task',
  'project_context',
  'constraint',
  'bug',
  'other'
]

const clampNumber = (value, min, max, fallback) => {
  const number = Number(value)

  if (Number.isNaN(number)) {
    return fallback
  }

  return Math.min(max, Math.max(min, number))
}

const normalizeMemory = (memory) => {
  const text = typeof memory.text === 'string' ? memory.text.trim() : ''

  if (!text) {
    return null
  }

  const type = MEMORY_TYPES.includes(memory.type) ? memory.type : 'other'

  return {
    text,
    type,
    importance: clampNumber(memory.importance, 1, 5, 3),
    confidence: clampNumber(memory.confidence, 0, 1, 0.7),
    reason: typeof memory.reason === 'string' ? memory.reason.trim() : ''
  }
}

const buildExtractionMessages = ({ conversation, maxMemories }) => [
  {
    role: 'system',
    content: [
      'You extract durable memories from AI conversations and coding sessions.',
      'Only keep information likely to matter in future sessions.',
      'Ignore greetings, filler, one-off wording, temporary debugging noise, and generic facts.',
      'Prefer concise first-person facts when the user is the subject.',
      'For coding sessions, keep project decisions, architecture, constraints, bugs, preferences, and tasks.',
      'Return only valid JSON. Do not include markdown.'
    ].join('\n')
  },
  {
    role: 'user',
    content: [
      `Extract up to ${maxMemories} useful memories from this conversation.`,
      '',
      'Use this JSON shape exactly:',
      '{',
      '  "memories": [',
      '    {',
      '      "text": "clean durable memory",',
      '      "type": "preference|fact|decision|task|project_context|constraint|bug|other",',
      '      "importance": 3,',
      '      "confidence": 0.8,',
      '      "reason": "why this is useful later"',
      '    }',
      '  ]',
      '}',
      '',
      'Importance scale: 1 = mildly useful, 3 = useful later, 5 = critical long-term context.',
      'Confidence scale: 0.0 = uncertain, 1.0 = directly stated.',
      '',
      'If nothing is worth remembering, return {"memories":[]}.',
      '',
      'Conversation:',
      conversation
    ].join('\n')
  }
]

const extractFromChunk = async ({ chunk, maxMemories, chunkIndex }) => {
  const messages = buildExtractionMessages({
    conversation: chunk,
    maxMemories
  })

  const content = await completeChat(messages, {
    temperature: 0,
    maxTokens: 800
  })

  const parsed = parseJsonObject(content, 'Memory extraction')
  const memories = Array.isArray(parsed.memories) ? parsed.memories : []

  const normalized = memories
    .slice(0, maxMemories)
    .map(normalizeMemory)
    .filter(Boolean)

  if (chunkIndex !== undefined) {
    console.log(`[pipeline] Memories extracted from chunk ${chunkIndex + 1}: ${normalized.length}`)
    normalized.forEach((m, i) => console.log(`[pipeline]   ${i + 1}. [${m.type}] (conf=${m.confidence}) ${m.text}`))
  }

  return normalized
}

const dedupeExtracted = (memories) => {
  const seen = new Set()
  const result = []

  for (const memory of memories) {
    const key = memory.text.toLowerCase().replace(/\s+/g, ' ').trim()
    if (seen.has(key)) continue
    seen.add(key)
    result.push(memory)
  }

  return result
}

const extractMemories = async ({ conversation, maxMemories = 5, chunks }) => {
  if (!conversation || typeof conversation !== 'string' || !conversation.trim()) {
    return []
  }

  const conversationText = conversation.trim()
  const conversationChunks = Array.isArray(chunks) && chunks.length > 0
    ? chunks
    : [conversationText]

  if (conversationChunks.length === 1) {
    const memories = await extractFromChunk({
      chunk: conversationChunks[0],
      maxMemories
    })
    return memories.slice(0, maxMemories)
  }

  const allMemories = []

  for (let i = 0; i < conversationChunks.length; i++) {
    const chunk = conversationChunks[i]
    try {
      const chunkMemories = await extractFromChunk({
        chunk,
        maxMemories,
        chunkIndex: i
      })
      allMemories.push(...chunkMemories)
    } catch (error) {
      console.error('chunk extraction failed:', error.message)
    }
  }

  return dedupeExtracted(allMemories).slice(0, maxMemories)
}

module.exports = {
  extractMemories,
  buildExtractionMessages,
  MEMORY_TYPES
}
