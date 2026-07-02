const Memory = require('../models/Memory')
const { embedText } = require('./embedService')

const retrieveMemory = async (query, sessionId, topK = 5) => {
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

  return results
}

module.exports = { retrieveMemory }