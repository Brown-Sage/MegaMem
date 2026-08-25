const Memory = require('../models/Memory')
const { embedText } = require('./embedService')
const { completeChat } = require('./groqService')
const { parseJsonObject } = require('../utils/json')
const { currentUserId } = require('../utils/ownership')
const { computeDedupKey } = require('../utils/dedupKey')

const CONFLICT_ACTIONS = ['create', 'update', 'skip', 'delete']

// Rows written inside this window may not be visible to $vectorSearch yet
// (Atlas Search indexes asynchronously, ~3s+ under load), so they are swept
// directly by dedupKey/recency and merged into the candidate pool.
const UNINDEXED_WINDOW_MS = 60 * 1000

// Merge vector + unindexed candidates, drop non-active/low-score rows, dedup by
// stable id, and normalize shape. Vector rows carry `_id` (no `id` field — the
// $project stage emits `_id` only), unindexed rows carry `id`. Keying on
// `m.id || String(m._id)` covers both so the same memory surfaced by both
// channels collapses to one entry.
const normalizeCandidates = ({ vectorResults, unindexed, minScore }) => {
  const seen = new Set()
  return [...vectorResults, ...unindexed]
    .filter(memory => !memory.status || memory.status === 'active')
    .filter(memory => typeof memory.score !== 'number' || memory.score >= minScore || memory.recent === true)
    .filter(memory => {
      const key = memory.id || String(memory._id)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .map(memory => ({
      id: memory.id || String(memory._id),
      text: memory.text,
      eventAt: memory.eventAt || null,
      createdAt: memory.createdAt,
      score: memory.score,
      recent: memory.recent || false
    }))
}

const findSimilarMemories = async ({ text, sessionId, topK = 8, minScore = 0.45, queryEmbedding = null }) => {
  const queryVector = queryEmbedding || await embedText(text)

  const [results, unindexed] = await Promise.all([
    Memory.aggregate([
      {
        $vectorSearch: {
          index: 'vector_index',
          path: 'embedding',
          queryVector: queryVector,
          numCandidates: 50,
          limit: topK,
          filter: { sessionId, userId: currentUserId() }
        }
      },
      {
        $project: {
          _id: 1,
          text: 1,
          status: 1,
          eventAt: 1,
          createdAt: 1,
          score: { $meta: 'vectorSearchScore' }
        }
      }
    ]),
    // Indexing-gap sweep: recent rows regardless of vector visibility.
    // Exact dedupKey match catches literal repeats; recency catches near-
    // duplicates written seconds ago that $vectorSearch cannot rank yet.
    Memory.find({
      userId: currentUserId(),
      sessionId,
      status: 'active',
      createdAt: { $gte: new Date(Date.now() - UNINDEXED_WINDOW_MS) }
    })
      .sort({ createdAt: -1 })
      .limit(10)
      .select('text status eventAt createdAt dedupKey')
      .lean()
      .then(rows => rows.map(row => ({
        ...row,
        id: row._id.toString(),
        score: computeDedupKey(text) === row.dedupKey ? 1 : null,
        recent: true
      })))
  ])

  // Post-filter on status: Atlas $vectorSearch only supports filter fields
  // declared in the Search index; 'status' isn't one (yet). Candidate sets
  // are small so filtering here is fine at personal scale.
  return normalizeCandidates({ vectorResults: results, unindexed, minScore })
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
      '- update: the new memory supersedes, refines, or corrects an existing memory about the same subject (e.g. a change of state). Store the new fact as memoryText; the old text is replaced in place.',
      '- delete: the new information INVALIDATES an existing memory outright ("I no longer use X", "we dropped Mongo", "that plan was cancelled"). Target the contradicted memory. If the invalidating fact is itself worth remembering long-term, also set memoryText to it — it will be stored as a new memory after the old one is removed. If only the removal matters, set memoryText to null.',
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
      '  "action": "create|update|skip|delete",',
      '  "targetMemoryId": "existing memory id for update/delete, else null",',
      '  "memoryText": "final memory text to store, or null",',
      '  "confidence": 0.8,',
      '  "reason": "short explanation"',
      '}',
      '',
      'Rules:',
      '- If the new memory refines or corrects an existing memory about the same subject (the old fact is outdated but was not wrong), choose update with the new fact as memoryText.',
      '- If the new memory states the old fact is no longer true, choose delete targeting it. Include memoryText only if the invalidating statement itself deserves to be remembered.',
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

const detectMemoryConflict = async ({ memory, sessionId, topK = 8, minScore = 0.45, queryEmbedding = null, extraCandidates = [] }) => {
  const text = typeof memory === 'string' ? memory : memory?.text

  if (!text || typeof text !== 'string' || !text.trim()) {
    throw new Error('detectMemoryConflict requires a memory text')
  }

  const candidates = await findSimilarMemories({
    text: text.trim(),
    sessionId,
    topK,
    minScore,
    queryEmbedding
  })

  // Recent writes are invisible to $vectorSearch until Atlas indexes them;
  // merge them in so rapid follow-up saves can still update/delete them.
  const seenIds = new Set(candidates.map(c => c.id))
  for (const rc of extraCandidates) {
    if (!rc || !rc.memoryId || seenIds.has(String(rc.memoryId))) continue
    const doc = await Memory.findOne({ _id: rc.memoryId, userId: currentUserId() })
      .select('text status eventAt createdAt')
      .lean()
    if (!doc || (doc.status && doc.status !== 'active')) continue
    candidates.push({
      id: String(rc.memoryId),
      text: doc.text,
      eventAt: doc.eventAt || null,
      createdAt: doc.createdAt,
      recent: true
    })
    seenIds.add(String(rc.memoryId))
  }

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
    maxTokens: 1000,
    timeoutMs: 20000
  })

  return {
    ...normalizeDecision(parseJsonObject(content, 'Memory conflict detection')),
    candidates
  }
}

module.exports = {
  detectMemoryConflict,
  findSimilarMemories,
  normalizeCandidates,
  buildConflictMessages,
  normalizeDecision
}
