const Memory = require('../models/Memory')
const { embedText } = require('./embedService')

// Atlas $vectorSearchScore for cosine similarity is 0..1 (0.5 = orthogonal).
// Empirically, genuine matches land around 0.64+ and noise around 0.57.
const DEFAULT_MIN_SCORE = process.env.MEGAMEM_MIN_SCORE
  ? Number(process.env.MEGAMEM_MIN_SCORE)
  : 0.6

const retrieveMemory = async (query, sessionId, topK = 5, minScore = DEFAULT_MIN_SCORE) => {
  const queryEmbedding = await embedText(query)

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
        score: { $meta: 'vectorSearchScore' },
        _id: 0
      }
    }
  ])

  return results.filter((memory) => memory.score >= minScore)
}

module.exports = { retrieveMemory, DEFAULT_MIN_SCORE }
