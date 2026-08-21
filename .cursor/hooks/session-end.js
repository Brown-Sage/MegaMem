const { spawn } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const { sessionLayersForWorkspace } = require('./common')

// Reads the transcript, snapshots it to tmp (Cursor may reclaim the original),
// then hands off to a detached worker and exits immediately — extraction can
// take minutes and must not block the editor's hook timeout.
const main = async () => {
  let input = ''
  for await (const chunk of process.stdin) input += chunk

  let payload = {}
  try { payload = JSON.parse(input || '{}') } catch { /* ignore */ }

  const transcriptPath = payload.transcript_path
  if (!transcriptPath) {
    process.stdout.write('{}\n')
    return
  }

  try {
    const raw = fs.readFileSync(transcriptPath, 'utf8')
    if (!raw.trim()) {
      process.stdout.write('{}\n')
      return
    }

    const snapshot = path.join(os.tmpdir(), `megamem-session-${Date.now()}.txt`)
    fs.writeFileSync(snapshot, raw)

    const layers = sessionLayersForWorkspace(payload.workspace_roots)
    const workerPath = path.join(__dirname, '..', '..', 'scripts', 'extraction-worker.js')

    const child = spawn(process.execPath, [
      workerPath,
      '--transcript', snapshot,
      '--user', layers.userId,
      '--workspace', layers.workspaceId
    ], {
      detached: true,
      stdio: 'ignore',
      env: process.env
    })
    child.unref()

    console.error(`[megamem session-end] extraction handed off to worker pid=${child.pid}`)
  } catch (error) {
    console.error('[megamem session-end]', error.message)
  }

  process.stdout.write('{}\n')
}

main()
