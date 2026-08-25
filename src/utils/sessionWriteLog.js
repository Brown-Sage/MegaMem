// Cross-process session write log (R2). The in-process recentWrites buffer
// dies with its process, so the detached session-end extraction worker can
// never see what mid-session saves already captured — it re-embeds and
// re-conflict-checks facts we already have (plan gap G2).
//
// This side-file is the shared record: every mid-session save appends its
// dedupKey here; the worker unions the logs for its target layers and skips
// matching facts before spending embed/LLM tokens.
//
// Best-effort by design: a missing or unreadable log degrades to today's
// behavior (conflict detection still absorbs duplicates downstream).

const fs = require('fs')
const path = require('path')
const os = require('os')
const crypto = require('crypto')

// Env override exists mainly so tests can isolate their scratch space.
const LOG_DIR = process.env.MEGAMEM_WRITE_LOG_DIR ||
  path.join(os.tmpdir(), 'megamem-write-log')

// Entries older than a day are irrelevant — sessions don't span that long,
// and anything older is safely visible to Atlas search anyway.
const ENTRY_TTL_MS = 24 * 60 * 60 * 1000

// Bound read cost on pathological (never-pruned) files.
const MAX_LINES = 5000

const fileFor = (sessionId) =>
  path.join(LOG_DIR, `writes-${crypto.createHash('sha1').update(String(sessionId)).digest('hex')}.jsonl`)

const recordSessionWrite = (sessionId, dedupKey) => {
  if (!sessionId || !dedupKey) return
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true })
    fs.appendFileSync(
      fileFor(sessionId),
      JSON.stringify({ d: dedupKey, t: Date.now() }) + '\n'
    )
  } catch {
    // Non-fatal: conflict detection still catches duplicates post-embed.
  }
}

// Returns the dedupKeys written recently for this session, [] when the log
// is absent/corrupt. Expired and malformed lines are ignored.
const readSessionWrites = (sessionId) => {
  if (!sessionId) return []
  let raw
  try {
    raw = fs.readFileSync(fileFor(sessionId), 'utf8')
  } catch {
    return []
  }
  const cutoff = Date.now() - ENTRY_TTL_MS
  const lines = raw.split('\n').filter(Boolean)
  if (lines.length > MAX_LINES) lines.splice(0, lines.length - MAX_LINES)

  const keys = []
  for (const line of lines) {
    try {
      const entry = JSON.parse(line)
      if (entry && entry.d && typeof entry.t === 'number' && entry.t >= cutoff) {
        keys.push(entry.d)
      }
    } catch { /* skip malformed line */ }
  }
  return keys
}

module.exports = { recordSessionWrite, readSessionWrites, LOG_DIR, ENTRY_TTL_MS }
