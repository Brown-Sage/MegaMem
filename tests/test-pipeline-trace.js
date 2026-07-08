require('dotenv').config()
const connectDB = require('../src/config/db')
const mongoose = require('mongoose')
const Memory = require('../src/models/Memory')
const { chatWithMemory, persistExtractedMemories, formatConversation } = require('../src/services/memoryChatService')

const SESSION_ID = `pipeline_trace_${Date.now()}`

const run = async () => {
  await connectDB()
  await Memory.deleteMany({ sessionId: SESSION_ID })

  console.log('=== TEST 1: short conversation (should produce 1 chunk, N extracted facts) ===')
  const shortConversation = formatConversation({
    query: 'I am building MegaMem, a memory layer for Cursor. I prefer TypeScript and I live in Berlin.',
    answer: 'Got it. Backend-heavy, TypeScript, Berlin. No frontend focus yet.'
  })

  const shortResults = await persistExtractedMemories({
    conversation: shortConversation,
    sessionId: SESSION_ID
  })
  console.log(`\n[result] actions: ${shortResults.map(r => r.action).join(', ')}`)

  console.log('\n\n=== TEST 2: long conversation (should produce multiple chunks) ===')
  const longConversation = formatConversation({
    query: Array.from({ length: 60 }, (_, i) =>
      `User turn ${i + 1}: ${i % 3 === 0 ? `I prefer using vim keybindings. ` : ''}${i % 5 === 0 ? `I live in Mumbai. ` : ''}${i % 7 === 0 ? `My project uses PostgreSQL. ` : ''}This is a longer turn to push the conversation past the chunk threshold.`
    ).join('\n'),
    answer: 'Acknowledged all the user inputs and provided guidance accordingly.'
  })

  const longResults = await persistExtractedMemories({
    conversation: longConversation,
    sessionId: SESSION_ID
  })
  console.log(`\n[result] actions: ${longResults.map(r => r.action).join(', ')}`)

  const stored = await Memory.find({ sessionId: SESSION_ID }).select('text -_id')
  console.log(`\n=== STORED MEMORIES (${stored.length}) ===`)
  stored.forEach((m, i) => {
    const isChunk = m.text.length > 500
    console.log(`  ${i + 1}. [len=${m.text.length}${isChunk ? ' ⚠️  CHUNK-SIZED' : ''}] ${m.text.slice(0, 120)}${m.text.length > 120 ? '...' : ''}`)
  })

  const chunkSized = stored.filter(m => m.text.length > 500)
  if (chunkSized.length > 0) {
    console.log(`\n❌ BUG CONFIRMED: ${chunkSized.length} memories are chunk-sized (raw text instead of extracted facts)`)
  } else {
    console.log('\n✅ All stored memories are extracted facts, not raw chunks.')
  }

  await Memory.deleteMany({ sessionId: SESSION_ID })
  await mongoose.disconnect()
}

run().catch(error => {
  console.error(error)
  process.exit(1)
})
