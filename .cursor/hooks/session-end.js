const { sessionLayersForWorkspace } = require('./common')
const connectDB = require('../../src/config/db')
const mongoose = require('mongoose')
const { persistExtractedMemories } = require('../../src/services/memoryChatService')
const { MEMORY_EXTRACT_MAX_CHARS } = require('../../src/validation/schemas')
const { log } = require('../../src/utils/log')

const capTranscript = (transcript) => {
  if (transcript.length <= MEMORY_EXTRACT_MAX_CHARS) return transcript
  return transcript.slice(-MEMORY_EXTRACT_MAX_CHARS)
}

const main = async () => {
  let input = ''
  for await (const chunk of process.stdin) input += chunk

  let payload = {}
  try { payload = JSON.parse(input || '{}') } catch { /* ignore */ }

  const layers = sessionLayersForWorkspace(payload.workspace_roots)
  const transcriptPath = payload.transcript_path

  if (!transcriptPath) {
    process.stdout.write('{}\n')
    return
  }

  try {
    const fs = require('fs')
    const raw = fs.readFileSync(transcriptPath, 'utf8')

    if (raw.trim().length === 0) {
      process.stdout.write('{}\n')
      return
    }

    const transcript = capTranscript(raw)

    await connectDB()
    const results = await persistExtractedMemories({
      conversation: transcript,
      userId: layers.userId,
      workspaceId: layers.workspaceId
    })
    const saved = results.filter((r) => r.action === 'create' || r.action === 'update')
    log(`[megamem session-end] ${saved.length} memories saved for user=${layers.userId} workspace=${layers.workspaceId}`)
    await mongoose.disconnect()
  } catch (error) {
    log('[megamem session-end]', error.message)
    try { await mongoose.disconnect() } catch { /* ignore */ }
  }

  process.stdout.write('{}\n')
}

main()
