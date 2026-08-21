// In-process ring buffer of recently written memories per sessionId.
// Closes the ~3s Atlas vector-index visibility gap: a fact written seconds
// ago is invisible to $vectorSearch but present here, so rapid duplicate
// saves are caught by cosine comparison instead of the LLM.

const WINDOW_MS = 10 * 60 * 1000
const MAX_ENTRIES = 500
const DUPLICATE_COSINE_THRESHOLD = 0.92

const entriesBySession = new Map()

const prune = (list) => {
  const cutoff = Date.now() - WINDOW_MS
  while (list.length > 0 && (list[0].at < cutoff || list.length > MAX_ENTRIES)) {
    list.shift()
  }
}

const cosineSimilarity = (a, b) => {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return 0
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  if (normA === 0 || normB === 0) return 0
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}

const recordWrite = ({ sessionId, memoryId = null, dedupKey, embedding }) => {
  if (!sessionId || !dedupKey || !Array.isArray(embedding)) return
  let list = entriesBySession.get(sessionId)
  if (!list) {
    list = []
    entriesBySession.set(sessionId, list)
  }
  list.push({ memoryId, dedupKey, embedding, at: Date.now() })
  prune(list)
}

// Returns {duplicate, reason} — true when an identical or near-identical
// memory was written so recently that the index cannot see it yet.
const checkRecentDuplicate = ({ sessionId, dedupKey, embedding }) => {
  const list = entriesBySession.get(sessionId)
  if (!list || list.length === 0) return { duplicate: false }

  prune(list)

  if (dedupKey && list.some((e) => e.dedupKey === dedupKey)) {
    return { duplicate: true, reason: 'Identical text written moments ago.' }
  }

  if (Array.isArray(embedding)) {
    for (let i = list.length - 1; i >= 0; i--) {
      const similarity = cosineSimilarity(embedding, list[i].embedding)
      if (similarity >= DUPLICATE_COSINE_THRESHOLD) {
        return { duplicate: true, reason: `Near-identical memory written moments ago (cosine ${similarity.toFixed(3)}).` }
      }
    }
  }

  return { duplicate: false }
}

// Recently written memories as conflict-detection candidates — these are
// invisible to $vectorSearch until Atlas indexes them (~3s+), so the write
// path must supply them explicitly.
const getRecentCandidates = (sessionId) => {
  const list = entriesBySession.get(sessionId)
  if (!list || list.length === 0) return []
  prune(list)
  return list
    .filter((e) => e.memoryId)
    .map((e) => ({
      memoryId: e.memoryId,
      dedupKey: e.dedupKey,
      embedding: e.embedding,
      at: e.at
    }))
}

const clear = () => entriesBySession.clear()

module.exports = {
  recordWrite,
  checkRecentDuplicate,
  getRecentCandidates,
  clear,
  cosineSimilarity,
  DUPLICATE_COSINE_THRESHOLD
}
