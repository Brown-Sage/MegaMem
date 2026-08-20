const path = require('path')
const { sessionIdForWorkspace } = require('./common')
const connectDB = require('../../src/config/db')
const mongoose = require('mongoose')
const { persistExtractedMemories } = require('../../src/services/memoryChatService')
const { log } = require('../../src/utils/log')

// sessionEnd is fire-and-forget. Reads the transcript path from the hook
// payload, extracts durable memories, and persists them asynchronously.
const main = async () => {
  let input = ''
  for await (const chunk of process.stdin) input += chunk

  let payload = {}
  try { payload = JSON.parse(input || '{}') } catch { /* ignore */ }

  const sessionId = sessionIdForWorkspace(payload.workspace_roots)
  const transcriptPath = payload.transcript_path

  if (!transcriptPath) {
    process.stdout.write('{}\n')
    return
  }

  try {
    const fs = require('fs')
    const transcript = fs.readFileSync(transcriptPath, 'utf8')

    if (transcript.trim().length === 0) {
      process.stdout.write('{}\n')
      return
    }

    await connectDB()
    const results = await persistExtractedMemories({ conversation: transcript, sessionId })
    const saved = results.filter((r) => r.action === 'create' || r.action === 'update')
    log(`[megamem session-end] ${saved.length} memories saved for ${sessionId}`)
    await mongoose.disconnect()
  } catch (error) {
    log('[megamem session-end]', error.message)
    try { await mongoose.disconnect() } catch { /* ignore */ }
  }

  process.stdout.write('{}\n')
}

main()
