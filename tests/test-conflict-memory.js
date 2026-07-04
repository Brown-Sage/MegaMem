require('dotenv').config()
const connectDB = require('../src/config/db')
const { detectMemoryConflict } = require('../src/services/conflictService')

const run = async () => {
  await connectDB()

  const decision = await detectMemoryConflict({
    memory: {
      text: 'I prefer Python over JavaScript',
      type: 'preference',
      importance: 3,
      confidence: 1
    },
    sessionId: 'session_001'
  })

  console.log('Similar memories:')
  decision.candidates.forEach(memory => {
    console.log(`[${memory.score.toFixed(3)}] ${memory.id} ${memory.text}`)
  })

  console.log('\nDecision:')
  console.log(JSON.stringify({
    action: decision.action,
    targetMemoryId: decision.targetMemoryId,
    memoryText: decision.memoryText,
    confidence: decision.confidence,
    reason: decision.reason
  }, null, 2))
}

run()
