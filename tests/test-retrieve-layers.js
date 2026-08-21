require('dotenv').config()
const mongoose = require('mongoose')
const connectDB = require('../src/config/db')
const Memory = require('../src/models/Memory')
const { saveMemory } = require('../src/services/memoryService')
const { retrieveMemory, searchLexical } = require('../src/services/retrieveService')

const run = async () => {
  await connectDB()

  const userId = `layer_user_${Date.now()}`
  const workspaceId = `layer_ws_${Date.now()}`
  const token = `install:mcp-${Date.now()}`

  await saveMemory('Aryan loves bhindi ki sabzi in layer tests', userId, 'preference')
  await saveMemory(`Use ${token} to write Cursor user MCP config`, workspaceId, 'decision')

  const merged = await retrieveMemory(
    'bhindi ki sabzi preference',
    [userId, workspaceId],
    5
  )
  console.log('merged vector hits:')
  merged.forEach((m) => console.log(`  [${m.layer}] ${m.score} ${m.text}`))

  const lexical = await searchLexical(token, [userId, workspaceId], 5)
  console.log(`lexical hits for ${token}: ${lexical.length}`)
  lexical.forEach((m) => console.log(`  - ${m.text}`))

  const fallback = await retrieveMemory(token, [userId, workspaceId], 5, 0.99)
  console.log(`fallback (minScore 0.99) hits: ${fallback.length}`)
  fallback.forEach((m) => console.log(`  [${m.layer}] score=${m.score} ${m.text}`))

  if (!lexical.some((m) => m.text.includes(token))) {
    console.error('FAIL: lexical search missed exact token')
    process.exitCode = 1
  }
  if (!fallback.some((m) => m.text.includes(token))) {
    console.error('FAIL: high minScore did not fall back to lexical')
    process.exitCode = 1
  }

  const stored = await Memory.find({ sessionId: { $in: [userId, workspaceId] } })
  const missingType = stored.find((m) => !m.type)
  if (missingType) {
    console.error('FAIL: persisted memory missing type')
    process.exitCode = 1
  } else {
    console.log('PASS: persisted type on both layers')
  }

  await Memory.deleteMany({ sessionId: { $in: [userId, workspaceId] } })
  await mongoose.disconnect()
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})
