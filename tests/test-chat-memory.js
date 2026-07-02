require('dotenv').config()
const connectDB = require('../src/config/db')
const { chatWithMemory } = require('../src/services/memoryChatService')

const run = async () => {
  await connectDB()

  const result = await chatWithMemory({
    query: 'What programming language do I prefer?',
    sessionId: 'session_001',
    topK: 5
  })

  console.log('Retrieved memories:')
  result.memories.forEach(memory => {
    console.log(`[${memory.score.toFixed(3)}] ${memory.text}`)
  })

  console.log('\nAnswer:')
  console.log(result.answer)
  process.exit(0)
}

run()
