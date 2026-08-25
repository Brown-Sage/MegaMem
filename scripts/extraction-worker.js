#!/usr/bin/env node
// Detached extraction worker for the Cursor session-end hook.
// The hook spawns this process and exits immediately so long extraction
// pipelines never hit the hook timeout. Runs independently of the editor.

const path = require('path')
require('dotenv').config({ path: path.join(__dirname, '..', '.env') })

const getArg = (name) => {
  const idx = process.argv.indexOf(`--${name}`)
  return idx !== -1 ? process.argv[idx + 1] : null
}

const main = async () => {
  const transcriptPath = getArg('transcript')
  const user = getArg('user')
  const workspace = getArg('workspace')

  if (!transcriptPath) {
    console.error('[extraction-worker] no transcript path given')
    process.exit(1)
  }

  const fs = require('fs')
  let raw = ''
  try {
    raw = fs.readFileSync(transcriptPath, 'utf8')
  } catch (err) {
    console.error(`[extraction-worker] cannot read transcript: ${err.message}`)
    process.exit(1)
  }

  if (!raw.trim()) {
    console.log('[extraction-worker] empty transcript, nothing to do')
    process.exit(0)
  }

  // Same cap as the previous synchronous hook behavior.
  const MEMORY_EXTRACT_MAX_CHARS = 50000
  const conversation = raw.length <= MEMORY_EXTRACT_MAX_CHARS
    ? raw
    : raw.slice(-MEMORY_EXTRACT_MAX_CHARS)

  const connectDB = require('../src/config/db')
  const mongoose = require('mongoose')
  const { persistExtractedMemories } = require('../src/services/memoryChatService')

  // R2: union the session write logs for every bucket this run can target,
  // so facts the agent already saved mid-session are skipped pre-embed.
  // Missing logs degrade silently to the old behavior.
  const { readSessionWrites } = require('../src/utils/sessionWriteLog')
  const layerIds = (user && workspace)
    ? [user, workspace]
    : require('../src/utils/sessionId').resolveSessionIds(undefined).ids
  const skipDedupKeys = new Set(layerIds.flatMap((id) => readSessionWrites(id)))

  await connectDB()
  try {
    const results = await persistExtractedMemories({
      conversation,
      ...(user && workspace ? { userId: user, workspaceId: workspace } : {}),
      skipDedupKeys,
      actor: 'hook'
    })
    const saved = results.filter(r => r.action === 'create' || r.action === 'update' || r.action === 'delete')
    const skippedByLog = results.filter(r => r.reason === 'Already captured earlier in this session.').length
    console.log(`[extraction-worker] ${saved.length} memories saved, ${skippedByLog} skipped by session write log (user=${user || 'default'} workspace=${workspace || 'default'})`)
  } finally {
    await mongoose.disconnect()
  }
}

main().catch(err => {
  console.error('[extraction-worker] failed:', err.message)
  process.exit(1)
})
