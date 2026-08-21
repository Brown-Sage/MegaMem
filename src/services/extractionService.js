const { completeChat } = require('./groqService')
const { parseJsonObject } = require('../utils/json')
const { child } = require('../utils/log')
const { MEMORY_TYPES, TECHNICAL_MEMORY_TYPES } = require('../constants/memoryTypes')

const log = child('extract')

const MAX_MEMORY_TEXT_LENGTH = 500

const clampNumber = (value, min, max, fallback) => {
  const number = Number(value)

  if (Number.isNaN(number)) {
    return fallback
  }

  return Math.min(max, Math.max(min, number))
}

const normalizeMemory = (memory) => {
  const text = typeof memory.text === 'string' ? memory.text.trim() : ''

  if (!text || text.length > MAX_MEMORY_TEXT_LENGTH) {
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

const buildReExtractionMessages = (oversized) => {
  const technicalOversized = oversized.filter(m => TECHNICAL_MEMORY_TYPES.includes(m.type))
  const nonTechnicalOversized = oversized.filter(m => !TECHNICAL_MEMORY_TYPES.includes(m.type))

  const lines = [
    'Compress each of these oversized memories to under 500 characters.',
    '',
    'For TECHNICAL memories (project_context, task, constraint, bug, decision): preserve specific details - file names, versions, error messages, URLs, and technical specifics.',
    ...technicalOversized.map((m, i) => `T${i + 1}. [${m.type}] ${m.text}`),
    '',
    'For NON-TECHNICAL memories (preference, fact, other): aggressively compress to 1-2 sentences. Keep only the core fact.',
    ...nonTechnicalOversized.map((m, i) => `N${i + 1}. [${m.type}] ${m.text}`),
    '',
    'Use this JSON shape exactly:',
    '{',
    '  "memories": [',
    '    { "text": "compressed under 500 chars", "type": "...", "importance": 3, "confidence": 0.8, "reason": "why this was compressed" }',
    '  ]',
    '}',
    '',
    'Return only valid JSON. Do not include markdown.'
  ]

  return [
    {
      role: 'system',
      content: [
        'You re-extract oversized memories into concise, durable versions under 500 characters.',
        'Preserve the essential information while removing filler. Return only valid JSON.'
      ].join('\n')
    },
    {
      role: 'user',
      content: lines.join('\n')
    }
  ]
}

const reExtractOversized = async (oversized, chunkIndex) => {
  const messages = buildReExtractionMessages(oversized)

  const content = await completeChat(messages, {
    temperature: 0,
    maxTokens: 2000,
    timeoutMs: 30000
  })

  const parsed = parseJsonObject(content, 'Re-extraction')
  const memories = Array.isArray(parsed.memories) ? parsed.memories : []

  const normalized = memories
    .map(normalizeMemory)
    .filter(Boolean)

  const chunkLabel = chunkIndex !== undefined ? `chunk ${chunkIndex + 1}` : 'chunk'
  log.info({ oversized: oversized.length, chunk: chunkLabel, survived: normalized.length }, 're-extraction complete')

  return normalized
}

const extractFromChunk = async ({ chunk, maxMemories, chunkIndex }) => {
  const messages = buildExtractionMessages({
    conversation: chunk,
    maxMemories
  })

  const content = await completeChat(messages, {
    temperature: 0,
    maxTokens: 2000,
    timeoutMs: 30000
  })

  const parsed = parseJsonObject(content, 'Memory extraction')
  const memories = Array.isArray(parsed.memories) ? parsed.memories : []

  const rawMemories = memories.slice(0, maxMemories)
  const normalized = []
  const oversized = []

  for (const raw of rawMemories) {
    const norm = normalizeMemory(raw)
    if (norm) {
      normalized.push(norm)
    } else if (typeof raw.text === 'string' && raw.text.trim().length > MAX_MEMORY_TEXT_LENGTH) {
      oversized.push(raw)
    }
  }

  if (oversized.length > 0) {
    try {
      const reExtracted = await reExtractOversized(oversized, chunkIndex)
      normalized.push(...reExtracted)
    } catch (error) {
      log.warn({ err: error.message, chunk: (chunkIndex ?? 0) + 1 }, 're-extraction failed')
    }
  }

  if (chunkIndex !== undefined) {
    log.info({ chunk: chunkIndex + 1, memories: normalized.length }, 'chunk extracted')
    log.debug({ memories: normalized.map(m => ({ type: m.type, confidence: m.confidence, text: m.text })) }, 'chunk memory detail')
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
      log.warn({ err: error.message }, 'chunk extraction failed')
    }
  }

  return dedupeExtracted(allMemories).slice(0, maxMemories)
}

module.exports = {
  extractMemories,
  buildExtractionMessages,
  normalizeMemory,
  dedupeExtracted,
  MEMORY_TYPES,
  TECHNICAL_MEMORY_TYPES
}
