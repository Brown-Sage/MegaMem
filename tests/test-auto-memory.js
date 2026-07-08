require('dotenv').config()
const mongoose = require('mongoose')
const connectDB = require('../src/config/db')
const Memory = require('../src/models/Memory')
const { chatWithMemory, persistExtractedMemories, formatConversation } = require('../src/services/memoryChatService')

const SESSION_ID = `auto_memory_test_${Date.now()}`

const run = async () => {
  await connectDB()

  await Memory.deleteMany({ sessionId: SESSION_ID })

  console.log('--- test 1: persistExtractedMemories on a fresh conversation ---')
  const conversation1 = formatConversation({
    query: 'I am building MegaMem, an MCP-first memory layer for coding assistants.',
    answer: 'Got it. Frontend is not the main focus, backend heavy, JavaScript-based.'
  })

  const results1 = await persistExtractedMemories({
    conversation: conversation1,
    sessionId: SESSION_ID
  })

  console.log('pipeline results:')
  results1.forEach((result, index) => {
    console.log(`  ${index + 1}. [${result.action}] ${result.text || ''}`)
    if (result.reason) console.log(`     reason: ${result.reason}`)
  })

  const stored1 = await Memory.find({ sessionId: SESSION_ID })
  console.log(`\nstored ${stored1.length} memories in session ${SESSION_ID}`)
  stored1.forEach(m => console.log(`  - ${m.text}`))

  console.log('\n--- test 2: conflicting fact triggers update (not duplicate) ---')
  const conversation2 = formatConversation({
    query: 'Actually, switch the project to TypeScript instead of JavaScript.',
    answer: 'Noted, switching the project to TypeScript.'
  })

  const results2 = await persistExtractedMemories({
    conversation: conversation2,
    sessionId: SESSION_ID
  })

  console.log('pipeline results:')
  results2.forEach((result, index) => {
    console.log(`  ${index + 1}. [${result.action}] ${result.text || ''}`)
    if (result.memoryId) console.log(`     memoryId: ${result.memoryId}`)
    if (result.reason) console.log(`     reason: ${result.reason}`)
  })

  const stored2 = await Memory.find({ sessionId: SESSION_ID })
  console.log(`\nstored ${stored2.length} memories after conflict (should be === stored1.length, no duplicates)`)
  stored2.forEach(m => console.log(`  - ${m.text}`))

  console.log('\n--- test 3: chatWithMemory triggers auto-extraction (fire-and-forget) ---')
  const beforeCount = await Memory.countDocuments({ sessionId: SESSION_ID })

  const chatResult = await chatWithMemory({
    query: 'For MegaMem I want to expose memory as an MCP tool that Cursor can call.',
    sessionId: SESSION_ID,
    topK: 5
  })

  console.log('answer:', chatResult.answer)

  await new Promise(resolve => setTimeout(resolve, 4000))

  const afterCount = await Memory.countDocuments({ sessionId: SESSION_ID })
  console.log(`memories before chat turn: ${beforeCount}`)
  console.log(`memories after chat turn:  ${afterCount}`)

  if (afterCount > beforeCount) {
    console.log('chatWithMemory auto-pipeline confirmed working.')
  } else {
    console.log('chatWithMemory auto-pipeline did not save anything (extraction may have decided nothing was durable).')
  }

  await new Promise(resolve => setTimeout(resolve, 8000))
  await Memory.deleteMany({ sessionId: SESSION_ID })
  await mongoose.disconnect()
}

run().catch(error => {
  console.error(error)
  process.exit(1)
})
