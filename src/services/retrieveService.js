const Memory = require('../models/Memory')
const { embedText } = require('./embedService')
const { userSessionId, workspaceSessionId, layerLabel } = require('../utils/sessionId')

// Atlas $vectorSearchScore for cosine similarity is 0..1 (0.5 = orthogonal).
// Empirically, genuine matches land around 0.64+ and noise around 0.57.
const DEFAULT_MIN_SCORE = process.env.MEGAMEM_MIN_SCORE
  ? Number(process.env.MEGAMEM_MIN_SCORE)
  : 0.6

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const asSessionIds = (sessionIdOrIds) => {
  const ids = Array.isArray(sessionIdOrIds) ? sessionIdOrIds : [sessionIdOrIds]
  return [...new Set(ids.filter(Boolean))]
}

const inferLayers = (sessionIds) => {
  const userId = userSessionId()
  const workspaceId = workspaceSessionId()
  const onlyExplicit = sessionIds.length === 1
    && sessionIds[0] !== userId
    && sessionIds[0] !== workspaceId

  if (onlyExplicit) {
    return { userId: sessionIds[0], workspaceId: sessionIds[0], explicit: sessionIds[0] }
  }

  return { userId, workspaceId, explicit: null }
}

const tokenizeQuery = (query) => [...new Set(
  query
    .split(/[\s,;!?()[\]{}"']+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3)
)]

const searchVector = async (sessionId, queryEmbedding, topK) => {
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
        text: 1,
        sessionId: 1,
        type: 1,
        score: { $meta: 'vectorSearchScore' }
      }
    }
  ])

  return results
}

const searchLexical = async (query, sessionIds, topK) => {
  const tokens = tokenizeQuery(query)
  if (tokens.length === 0) return []

  const pattern = tokens.map(escapeRegex).join('|')

  return Memory.find({
    sessionId: { $in: sessionIds },
    text: { $regex: pattern, $options: 'i' }
  })
    .select('text sessionId type')
    .sort({ _id: -1 })
    .limit(topK)
    .lean()
}

const shapeResult = (memory, layers, score) => ({
  text: memory.text,
  score,
  sessionId: memory.sessionId,
  type: memory.type || 'other',
  layer: layerLabel(memory.sessionId, layers)
})

const retrieveMemory = async (query, sessionIdOrIds, topK = 5, minScore = DEFAULT_MIN_SCORE) => {
  const sessionIds = asSessionIds(sessionIdOrIds)
  if (sessionIds.length === 0) return []

  const layers = inferLayers(sessionIds)
  const queryEmbedding = await embedText(query)

  const batches = await Promise.all(
    sessionIds.map((sessionId) => searchVector(sessionId, queryEmbedding, topK))
  )

  const merged = new Map()
  for (const memory of batches.flat()) {
    const id = memory._id.toString()
    const existing = merged.get(id)
    if (!existing || memory.score > existing.score) {
      merged.set(id, memory)
    }
  }

  const ranked = [...merged.values()]
    .filter((memory) => memory.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map((memory) => shapeResult(memory, layers, memory.score))

  if (ranked.length > 0) return ranked

  const lexical = await searchLexical(query, sessionIds, topK)
  return lexical.map((memory) => shapeResult(memory, layers, null))
}

module.exports = { retrieveMemory, searchLexical, DEFAULT_MIN_SCORE }
