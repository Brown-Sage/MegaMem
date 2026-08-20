const { sessionIdForWorkspace } = require('./common')
const connectDB = require('../../src/config/db')
const mongoose = require('mongoose')
const { retrieveMemory } = require('../../src/services/retrieveService')

// Reads hook JSON from stdin and injects recent context at session start via
// the `additional_context` field (Cursor sessionStart only supports that field
// for context injection; beforeSubmitPrompt cannot inject).
const main = async () => {
  let input = ''
  for await (const chunk of process.stdin) input += chunk

  let payload = {}
  try { payload = JSON.parse(input || '{}') } catch { /* ignore */ }

  const sessionId = sessionIdForWorkspace(payload.workspace_roots)

  try {
    await connectDB()
    const memories = await retrieveMemory('important preferences and project context', sessionId, 5)
    const block = memories.length > 0
      ? memories.map((m) => `- ${m.text}`).join('\n')
      : '(no memories yet for this workspace)'

    const output = {
      additional_context: `[MegaMem] Relevant memories for this workspace:\n${block}`
    }
    process.stdout.write(JSON.stringify(output) + '\n')
    await mongoose.disconnect()
  } catch (error) {
    console.error('[megamem session-start]', error.message)
    process.stdout.write('{}\n')
    try { await mongoose.disconnect() } catch { /* ignore */ }
  }
}

main()
