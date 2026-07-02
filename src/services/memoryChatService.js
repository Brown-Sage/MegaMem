const { retrieveMemory } = require('./retrieveService')
const { completeChat } = require('./groqService')
const { buildPrompt } = require('./promptService')

const chatWithMemory = async ({ query, sessionId, topK = 5 }) => {
  const memories = await retrieveMemory(query, sessionId, topK)
  const messages = buildPrompt({ query, memories })
  const answer = await completeChat(messages)

  return {
    answer,
    memories
  }
}

module.exports = { chatWithMemory }
