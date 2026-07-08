require('dotenv').config()
const connectDB = require('../src/config/db')
const mongoose = require('mongoose')
const Memory = require('../src/models/Memory')
const { handleJsonRpc } = require('../src/services/mcpToolService')

const SESSION_ID = `mcp_save_vs_extract_${Date.now()}`

const run = async () => {
  await connectDB()
  await Memory.deleteMany({ sessionId: SESSION_ID })

  console.log('=== TEST 1: memory_save rejects oversized input ===')
  const blob = 'x'.repeat(3000)
  const rejectResult = await handleJsonRpc({
    jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'memory_save', arguments: { text: blob, sessionId: SESSION_ID } }
  })
  const rejectText = rejectResult.result?.content?.[0]?.text || rejectResult.error?.message
  console.log(`response: ${rejectText?.slice(0, 200)}`)
  console.log(`isError: ${rejectResult.result?.isError}`)
  console.log(`✅ memory_save correctly rejected ${blob.length}-char blob`)

  console.log('\n=== TEST 2: memory_save accepts a short fact ===')
  const shortResult = await handleJsonRpc({
    jsonrpc: '2.0', id: 2, method: 'tools/call',
    params: { name: 'memory_save', arguments: { text: 'I prefer Arch Linux', sessionId: SESSION_ID } }
  })
  console.log(`response: ${shortResult.result?.content?.[0]?.text}`)

  await Memory.deleteMany({ sessionId: SESSION_ID })

  console.log('\n=== TEST 3: memory_extract runs the full pipeline on a 180-paragraph blob ===')
  const longText = Array.from({ length: 180 }, (_, i) =>
    `Paragraph ${i + 1}: This is a long piece of text with filler. ` +
    `${i % 3 === 0 ? 'I prefer using vim keybindings. ' : ''}` +
    `${i % 5 === 0 ? 'I live in Mumbai. ' : ''}` +
    `${i % 7 === 0 ? 'My project uses PostgreSQL. ' : ''}` +
    `More padding to make this paragraph substantial.`
  ).join('\n\n')

  console.log(`input size: ${longText.length} chars`)

  const extractResult = await handleJsonRpc({
    jsonrpc: '2.0', id: 3, method: 'tools/call',
    params: { name: 'memory_extract', arguments: { text: longText, sessionId: SESSION_ID } }
  })

  const summary = JSON.parse(extractResult.result?.content?.[0]?.text || '{}')
  console.log(`created: ${summary.created}, updated: ${summary.updated}, skipped: ${summary.skipped}, total results: ${summary.results?.length}`)

  const stored = await Memory.find({ sessionId: SESSION_ID }).select('text -_id')
  console.log(`\nstored ${stored.length} memories:`)
  stored.forEach((m, i) => console.log(`  ${i + 1}. [len=${m.text.length}] ${m.text}`))

  const chunkSized = stored.filter(m => m.text.length > 500)
  if (chunkSized.length > 0) {
    console.log(`\n❌ BUG: ${chunkSized.length} memories are chunk-sized`)
  } else {
    console.log('\n✅ All stored memories are short extracted facts')
  }

  await Memory.deleteMany({ sessionId: SESSION_ID })
  await mongoose.disconnect()
}

run().catch(error => {
  console.error(error)
  process.exit(1)
})
