require('dotenv').config()
const mongoose = require('mongoose')
const connectDB = require('../src/config/db')
const { detectMemoryConflict } = require('../src/services/conflictService')
const { applyMemoryDecision } = require('../src/services/memoryService')

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

  const result = await applyMemoryDecision({
    decision,
    sessionId: 'session_001',
    fallbackText: 'I prefer Python over JavaScript'
  })

  console.log('\nApplied:')
  console.log(JSON.stringify({
    action: result.action,
    memoryId: result.memory?._id?.toString() || null,
    text: result.memory?.text || null,
    reason: result.reason
  }, null, 2))

  await mongoose.disconnect()
}

run()
