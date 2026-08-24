const { completeChat } = require('./groqService')
const { parseJsonObject } = require('./../utils/json')
const { child } = require('../utils/log')
const { MEMORY_TYPES, TECHNICAL_MEMORY_TYPES } = require('../constants/memoryTypes')

const log = child('extract')

const MAX_MEMORY_TEXT_LENGTH = 500

// Extraction works on smaller chunks than retrieval so the model emits
// discrete facts instead of compressing a whole session into vague summaries.
const EXTRACTION_CHUNK_CHARS = 1800
const EXTRACTION_CHUNK_OVERLAP = 200
const EXTRACTION_MAX_CHUNKS = 40

// Per-chunk fact budget scales with chunk size; bounded to protect latency.
// Coverage analysis on LoCoMo showed the old chars/1500 budget (~2 facts per
// 1800-char chunk) was the main cause of answers-not-in-store; ~1 fact per
// 700-800 chars keeps extraction density close to what conversations carry.
const scaledMaxMemories = (chars) => Math.min(40, Math.max(6, Math.ceil(chars / 750)))

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

const buildExtractionMessages = ({ conversation, maxMemories, context }) => [
  {
    role: 'system',
    content: [
      'You extract durable memories from AI conversations and coding sessions.',
      'Only keep information likely to matter in future sessions.',
      'Ignore greetings, filler, one-off wording, temporary debugging noise, and generic facts.',
      'Prefer concise first-person facts when the user is the subject.',
      'For coding sessions, keep project decisions, architecture, constraints, bugs, preferences, and tasks.',
      'Return only valid JSON. Do not include markdown.',
      '',
      'Extract DISCRETE atomic facts — one fact per memory. Never summarize a whole topic into one memory.',
      '',
      'GOOD memories (specific, self-contained, reusable later):',
      '- "Caroline went to the LGBTQ support group on 7 May 2023 and found it powerful."',
      '- "Melanie signed up for a pottery class on 2 July 2023 to destress after work."',
      '- "The team dropped MongoDB for Postgres because vector search pricing was too high."',
      '- "Sam prefers tabs over spaces and always wants tests before refactoring."',
      '',
      'BAD memories (vague summaries that lose detail):',
      '- "Caroline values community and creative outlets."',
      '- "Melanie is focused on self-care activities."',
      '- "The team discussed database options."',
      '',
      'RULES for dates and times:',
      '- NEVER write bare relative time phrases like "last year", "last week", "last Friday", "this month", or "next month" in the memory text.',
      '- If the conversation states an absolute date, use that exact date.',
      '- If only a relative phrase is given, still keep the relative phrase BUT make the rest of the fact maximally specific (who, what, where).',
      '',
      'RULES for identity and facts about people:',
      '- Always state facts explicitly with the person\'s name as the subject: "Caroline is a transgender woman", NOT "Caroline discussed her journey".',
      '- Include concrete details the speaker actually said (numbers, names, places, reasons) — do not compress them into abstractions like "expressed support".',
      '- If someone reacts to something, capture WHAT they said specifically, not just that they reacted positively.',
    ].join('\n')
  },
  {
    role: 'user',
    content: [
      `Extract up to ${maxMemories} useful memories from this conversation.`,
      context ? '\nEarlier conversation context (use ONLY to resolve pronouns and references; do not extract memories from it):\n' + context : '',
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
      'Keep dates, names, versions, and numbers verbatim whenever they appear.',
      '',
      'If nothing is worth remembering, return {"memories":[]}.',
      '',
      'Conversation:',
      conversation
    ].filter(Boolean).join('\n')
  }
]

const buildSummarizationMessages = ({ previousSummary, chunk }) => [
  {
    role: 'system',
    content: 'You maintain a running summary of a long conversation. Return only the summary text, nothing else.'
  },
  {
    role: 'user',
    content: [
      'Fold the new conversation segment into the running summary.',
      `Keep it under 300 words. Preserve names, dates, decisions, and open questions.`,
      previousSummary ? `\nCurrent summary:\n${previousSummary}` : '\nThere is no summary yet — create one.',
      `\nNew segment:\n${chunk}`
    ].join('\n')
  }
]

// Rolling context lets later chunks resolve pronouns ("She went..." → name)
// and avoid re-extracting facts already captured earlier in the conversation.
const updateRunningSummary = async (previousSummary, chunk) => {
  try {
    const content = await completeChat(buildSummarizationMessages({ previousSummary, chunk }), {
      temperature: 0,
      maxTokens: 800,
      timeoutMs: 30000
    })
    const cleaned = content.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
    return cleaned.slice(0, 2000)
  } catch (err) {
    log.warn({ err: err.message }, 'running summary update failed')
    return previousSummary || ''
  }
}

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

const extractFromChunk = async ({ chunk, maxMemories, chunkIndex, context }) => {
  const messages = buildExtractionMessages({
    conversation: chunk,
    maxMemories,
    context
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

const extractMemories = async ({ conversation, maxMemories, chunks, context }) => {
  if (!conversation || typeof conversation !== 'string' || !conversation.trim()) {
    return []
  }

  const conversationText = conversation.trim()
  const conversationChunks = Array.isArray(chunks) && chunks.length > 0
    ? chunks
    : [conversationText]

  // No total cap: each chunk contributes its own budget so long transcripts
  // yield proportionally more facts instead of being silently truncated.
  const allMemories = []

  for (let i = 0; i < conversationChunks.length; i++) {
    const chunk = conversationChunks[i]
    try {
      const chunkBudget = maxMemories ?? scaledMaxMemories(chunk.length)
      const chunkMemories = await extractFromChunk({
        chunk,
        maxMemories: chunkBudget,
        chunkIndex: conversationChunks.length > 1 ? i : undefined,
        context
      })
      allMemories.push(...chunkMemories)
    } catch (error) {
      log.warn({ err: error.message }, 'chunk extraction failed')
    }
  }

  return dedupeExtracted(allMemories)
}

// Session-end fact-sheet pass (B2): one extra LLM call over the rolling
// summary that compiles EXPLICIT facts about each person — identity,
// relationship status, family, job, plans/events with dates. Chunked
// extraction keeps dropping these ("X discussed her journey" instead of
// "X is a transgender woman"), and QA evals showed identity/status facts
// were the single biggest answers-not-in-store category.
const buildFactSheetMessages = ({ summary, existingTexts }) => [
  {
    role: 'system',
    content: [
      'You compile a fact sheet of explicit, durable facts about people from a conversation summary.',
      '',
      'HARD REQUIREMENTS:',
      '- Every fact must be STATED or clearly established in the summary. Never invent or infer.',
      '- State each fact explicitly with the person\'s name as subject: "Caroline is a transgender woman", "Caroline is single", "Dave wants to open a car maintenance shop".',
      '- Include: identity, relationship status, family, pets, job/education, where they live, goals/plans, and events/plans that have specific dates.',
      '- For anything with a date, write the absolute date from the summary (never "last week" / "next month").',
      '- Do NOT repeat facts already extracted (list provided) — only add missing ones.',
      '- Return only valid JSON. No markdown.'
    ].join('\n')
  },
  {
    role: 'user',
    content: [
      'Conversation summary:',
      summary || '(no summary available)',
      '',
      'Facts already extracted (do not duplicate):',
      existingTexts.length ? existingTexts.map((t) => `- ${t}`).join('\n') : '(none)',
      '',
      'Compile up to 15 additional explicit person-facts the list above is missing.',
      'Use this JSON shape exactly:',
      '{',
      '  "memories": [',
      '    { "text": "explicit fact", "type": "fact", "importance": 3, "confidence": 0.8 }',
      '  ]',
      '}'
    ].filter(Boolean).join('\n')
  }
]

const extractFactSheet = async ({ summary, existingTexts = [] }) => {
  if (!summary || !summary.trim()) return []

  try {
    const content = await completeChat(
      buildFactSheetMessages({ summary: summary.trim(), existingTexts }),
      { temperature: 0, maxTokens: 2000, timeoutMs: 30000 }
    )
    const parsed = parseJsonObject(content, 'Fact sheet extraction')
    const memories = Array.isArray(parsed.memories) ? parsed.memories : []
    const normalized = memories.map(normalizeMemory).filter(Boolean)
    log.info({ requested: memories.length, kept: normalized.length }, 'fact-sheet pass complete')
    return normalized
  } catch (error) {
    // The fact sheet is additive — a failure must not break persistence.
    log.warn({ err: error.message }, 'fact-sheet pass failed')
    return []
  }
}

module.exports = {
  extractMemories,
  extractFactSheet,
  buildExtractionMessages,
  normalizeMemory,
  dedupeExtracted,
  updateRunningSummary,
  scaledMaxMemories,
  EXTRACTION_CHUNK_CHARS,
  EXTRACTION_CHUNK_OVERLAP,
  EXTRACTION_MAX_CHUNKS,
  MEMORY_TYPES,
  TECHNICAL_MEMORY_TYPES
}
