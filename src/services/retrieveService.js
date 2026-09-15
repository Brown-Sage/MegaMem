const Memory = require('../models/Memory')
const { embedText } = require('./embedService')
const { completeChat } = require('./groqService')
const { currentUserId } = require('../utils/ownership')
const { userSessionId, workspaceSessionId, layerLabel } = require('../utils/sessionId')
const { child } = require('../utils/log')
const { bump } = require('../utils/counters')

const log = child('retrieve')

// Atlas $vectorSearchScore for cosine similarity is 0..1 (0.5 = orthogonal).
// Empirically, genuine matches land around 0.64+ and noise around 0.57.
const DEFAULT_MIN_SCORE = process.env.MEGAMEM_MIN_SCORE
  ? Number(process.env.MEGAMEM_MIN_SCORE)
  : 0.6

// Lexical-only hits get a pseudo-score on the cosine scale (0.5 = orthogonal):
// overlap 0.5 → ~0.72, overlap 1.0 → ~0.95, i.e. a memory matching every query
// term outranks a weak cosine match but loses to a strong one.
const LEXICAL_BASE = 0.5
const LEXICAL_SPAN = 0.45

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const asSessionIds = (sessionIdOrIds) => {
  const ids = Array.isArray(sessionIdOrIds) ? sessionIdOrIds : [sessionIdOrIds]
  return [...new Set(ids.filter(Boolean))]
}

const inferLayers = (sessionIds) => {
  const userId = userSessionId()
  const cwdWorkspaceId = workspaceSessionId()
  const onlyExplicit = sessionIds.length === 1
    && sessionIds[0] !== userId
    && sessionIds[0] !== cwdWorkspaceId

  if (onlyExplicit) {
    return { userId: sessionIds[0], workspaceId: sessionIds[0], explicit: sessionIds[0] }
  }

  // Trust the buckets the caller resolved rather than re-deriving the workspace
  // from process.cwd(): a user-level Cursor hook is spawned in ~/.cursor/, so
  // that guess mislabeled its workspace memories as [explicit].
  const workspaceId = sessionIds.find((id) => id !== userId) || cwdWorkspaceId

  return { userId, workspaceId, explicit: null }
}

// Lexical channel (W4): always-on second signal, not just a fallback. A memory
// matching >= half the query tokens is a candidate even when cosine is weak —
// this catches paraphrase-phrased queries where embeddings under-retrieve.
const LEXICAL_MIN_OVERLAP = 0.5

// Importance tie-break (W1): importance 1-5 maps to a ±0.02 nudge so it can
// reorder near-ties but never overpower a meaningful cosine difference.
const IMPORTANCE_BOOST_WEIGHT = 0.01

const searchVector = async (sessionId, queryEmbedding, topK) => {
  // Wider pool than topK: fusion needs headroom to merge/rerank candidates,
  // and at ~200-memory store scale the raw top-5 is often all noise.
  const limit = Math.max(topK * 4, 20)
  const numCandidates = process.env.MEGAMEM_NUM_CANDIDATES
    ? Number(process.env.MEGAMEM_NUM_CANDIDATES)
    : Math.max(100, topK * 20)
  const results = await Memory.aggregate([
    {
      $vectorSearch: {
        index: 'vector_index',
        path: 'embedding',
        queryVector: queryEmbedding,
        numCandidates,
        limit,
        // userId must be a filter field in the Atlas Search index for this
        // to actually constrain results — keep vector_index definition in sync.
        filter: { sessionId, userId: currentUserId() }
      }
    },
    {
      $project: {
        text: 1,
        sessionId: 1,
        type: 1,
        status: 1,
        eventAt: 1,
        importance: 1,
        confidence: 1,
        score: { $meta: 'vectorSearchScore' }
      }
    }
  ])

  // Post-filter on status — see note in conflictService: 'status' is not a
  // filter path in the Search index, so filtering happens after retrieval.
  return results.filter((memory) => !memory.status || memory.status === 'active')
}

const tokenizeQuery = (query) => [...new Set(
  query
    .split(/[\s,;!?()[\]{}"']+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3)
)]

// Returns memories with `lexicalOverlap` (0..1 = matched query tokens / total).
const searchLexicalScored = async (query, sessionIds, limit) => {
  const tokens = tokenizeQuery(query)
  if (tokens.length === 0) return []

  const pattern = tokens.map(escapeRegex).join('|')

  const candidates = await Memory.find({
    userId: currentUserId(),
    sessionId: { $in: sessionIds },
    status: 'active',
    text: { $regex: pattern, $options: 'i' }
  })
    .select('text sessionId type eventAt importance confidence')
    .sort({ _id: -1 })
    .limit(limit * 5)
    .lean()

  return candidates
    .map((memory) => {
      const lowerText = memory.text.toLowerCase()
      const matched = tokens.filter((t) => lowerText.includes(t.toLowerCase())).length
      return { ...memory, lexicalOverlap: matched / tokens.length }
    })
    .filter((memory) => memory.lexicalOverlap >= LEXICAL_MIN_OVERLAP)
    .slice(0, limit)
}

const shapeResult = (memory, layers, score, fusedScore = score) => ({
  text: memory.text,
  score,
  fusedScore,
  sessionId: memory.sessionId,
  type: memory.type || 'other',
  importance: memory.importance ?? 3,
  confidence: memory.confidence ?? null,
  layer: layerLabel(memory.sessionId, layers)
})

// LLM relevance gate: cosine similarity cannot separate "topically adjacent"
// from "actually answers the question" (LoCoMo: irrelevant questions retrieved
// memories at cosine 0.76-0.91, same range as true hits). One cheap Groq call
// decides whether ANY retrieved memory genuinely answers the query. When it
// says no, we return [] so callers answer "I don't know" instead of
// hallucinating from unrelated context.

const buildRelevanceMessages = ({ query, memories }) => [
  {
    role: 'system',
    content: [
      'You are a relevance judge for a memory system.',
      'Given a question and candidate memories, decide if any memory can ANSWER the question.',
      'A memory counts if it directly states the answer OR provides the specific facts needed to derive it (a date, name, place, number, or event the question asks about).',
      'A relative time phrase paired with its resolved date (e.g. "next month (June 2023)") counts as providing that date.',
      'Topical similarity alone is NOT enough — a memory that merely discusses the same topic without the needed detail is irrelevant.',
      'Answer only YES or NO.'
    ].join('\n')
  },
  {
    role: 'user',
    content: [
      `Question: ${query}`,
      '',
      'Candidate memories:',
      ...memories.map((m, i) => `${i + 1}. ${m.text}`),
      '',
      'Does any memory provide the information needed to answer the question? Reply with only YES or NO.'
    ].join('\n')
  }
]

// Strict verdict parse: reasoner think-blocks are stripped first (they may
// legitimately contain either word), then the reply must START with YES or
// NO. Anything else (empty budget-starved content, rambling prose) counts as
// "no decision rendered" rather than a NO — see relevanceGate.
const parseGateVerdict = (rawContent) => {
  const content = String(rawContent || '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .trim()
  const match = /^(YES|NO)\b/i.exec(content)
  return match ? match[1].toUpperCase() : null
}

// Returns {gated:boolean} — gated=true means the candidates were judged
// non-answerable and the caller should treat retrieval as empty.
const relevanceGate = async (query, memories) => {
  if (memories.length === 0) return { gated: false }

  try {
    const content = await completeChat(buildRelevanceMessages({ query, memories }), {
      temperature: 0,
      // gpt-oss is a reasoner: hidden reasoning tokens count against max_tokens,
      // so a tiny budget returns empty content (verified: 5 tokens → '').
      maxTokens: 200,
      timeoutMs: 8000,
      // The gate is cheap but frequent; under provider rate limits (Mistral
      // free tier 429s aggressively) extra retries honoring Retry-After keep
      // it from silently failing open and letting adversarial queries through.
      maxRetries: 4
    })
    const verdict = parseGateVerdict(content)
    if (verdict === 'NO') return { gated: true }
    if (verdict === 'YES') return { gated: false, passed: true }
    // No decision rendered (empty/garbage content — reachable when reasoning
    // tokens eat the whole max_tokens budget under load). Mechanical failure
    // is not a judgment of irrelevance: fail open like the error path below,
    // but flag it so the caller counts it separately in /stats.
    return { gated: false, failedOpen: true, failedEmpty: true }
  } catch (err) {
    // Fail open: if the gate itself errors, keep the vector results rather
    // than losing good retrievals because the judge is down.
    log.warn({ err: err.message }, 'relevance gate error; keeping results')
    return { gated: false, failedOpen: true }
  }
}

// Runner-ups from the fusion pool double as related-memory links (2b): they
// already matched the query channels but lost the ranking cut. Zero extra
// DB round-trips — they exist in memory before the slice.
const pickRelated = (rankedPool, limit) =>
  rankedPool.slice(0, limit).map((m) => ({
    memoryId: m._id ? m._id.toString() : null,
    text: m.text,
    score: m.fusedScore,
    layer: layerLabel(m.sessionId, m.layers)
  }))

const retrieveMemory = async (query, sessionIdOrIds, topK = 5, minScore = DEFAULT_MIN_SCORE, { relevanceGate: useGate = true, relatedLimit = 0 } = {}) => {
  const sessionIds = asSessionIds(sessionIdOrIds)
  if (sessionIds.length === 0) return []

  const layers = inferLayers(sessionIds)
  const queryEmbedding = await embedText(query)

  // Both channels always run (W4) — vector catches paraphrases, lexical
  // catches exact-term phrasing mismatch; fusion merges the candidate pools.
  const poolSize = Math.max(topK * 4, 20)
  const [batches, lexicalHits] = await Promise.all([
    Promise.all(sessionIds.map((sessionId) => searchVector(sessionId, queryEmbedding, topK))),
    searchLexicalScored(query, sessionIds, poolSize)
  ])

  // Fusion: one entry per memory. Candidates qualify via EITHER channel
  // (vector >= threshold OR strong lexical overlap). Ranking score is the
  // primary channel score mapped to a comparable scale plus the small
  // importance nudge — cosine still dominates, lexical-only hits enter at a
  // level proportional to how many query terms they match.
  const fused = new Map()
  for (const memory of batches.flat()) {
    if (memory.score < minScore) continue
    fused.set(memory._id.toString(), { ...memory, lexicalOverlap: null })
  }
  for (const memory of lexicalHits) {
    const id = memory._id.toString()
    const existing = fused.get(id)
    if (existing) {
      existing.lexicalOverlap = memory.lexicalOverlap
      continue
    }
    fused.set(id, memory)
  }

  const importanceNudge = (m) => ((m.importance ?? 3) - 3) * IMPORTANCE_BOOST_WEIGHT
  const primaryScore = (m) =>
    m.score != null ? m.score : LEXICAL_BASE + (LEXICAL_SPAN * m.lexicalOverlap)

  const scored = [...fused.values()]
    .map((m) => ({ ...m, layers, fusedScore: primaryScore(m) + importanceNudge(m) }))
    .sort((a, b) => b.fusedScore - a.fusedScore)
  const ranked = scored.slice(0, topK).map((m) => shapeResult(m, layers, m.score ?? null, m.fusedScore))

  if (ranked.length > 0 && useGate) {
    // Gate only fires when we would otherwise answer from memory.
    bump('gate.fired', sessionIds[0])
    const verdict = await relevanceGate(query, ranked)
    if (verdict.gated) {
      bump('gate.gated', sessionIds[0])
      log.info({ query: query.slice(0, 80) }, 'relevance gate: no memory answers this; returning empty')
      if (relatedLimit > 0) return { memories: [], related: [] }
      return []
    }
    if (verdict.failedEmpty) bump('gate.failedEmpty', sessionIds[0])
    else if (verdict.failedOpen) bump('gate.failedOpen', sessionIds[0])
    else bump('gate.passed', sessionIds[0])
  }

  if (relatedLimit > 0) {
    // Related links come from the runner-up pool (never duplicates of hits),
    // so gate-gated queries and thin stores naturally yield fewer/none.
    return { memories: ranked, related: pickRelated(scored.slice(topK), relatedLimit) }
  }

  return ranked
}

module.exports = { retrieveMemory, searchLexical: searchLexicalScored, relevanceGate, parseGateVerdict, pickRelated, inferLayers, DEFAULT_MIN_SCORE }
