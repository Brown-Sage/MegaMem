// In-process pipeline counters (R1). Zero dependencies, lost on restart by
// design — persistence is premature until something consumes it. Exposed via
// GET /stats and surfaced in npm run doctor.
//
// Schema is fixed: bumping an unregistered path throws. This keeps typos from
// silently creating phantom metrics — a counter that never increments looks
// identical to a pipeline that never fires, which is exactly the failure mode
// (G1/G4) this module exists to expose.

const STARTED_AT = Date.now()

// Global schema. Per-session breakdown mirrors these same paths.
const SCHEMA = {
  'saves.create': 0,
  'saves.update': 0,
  'saves.delete': 0,
  'saves.skip': 0,
  'saves.error': 0,
  'searches.count': 0,
  'gate.fired': 0,
  'gate.passed': 0,
  'gate.gated': 0,
  'gate.failedOpen': 0,
  'gate.failedEmpty': 0,
  'extraction.runs': 0,
  'extraction.completed': 0,
  'extraction.failed': 0,
  'extraction.factsExtracted': 0,
  'extraction.skippedByWriteLog': 0,
  'hook.fires': 0,
  'hook.matches': 0,
  'hook.injections': 0,
  'hook.errors': 0
}

const globalCounts = {}
for (const key of Object.keys(SCHEMA)) globalCounts[key] = 0

// Per-session breakdown: capped LRU so long-lived servers can't grow forever.
const MAX_SESSIONS = 50
const sessions = new Map()

const assertPath = (path) => {
  if (!(path in SCHEMA)) {
    throw new Error(`counters: unknown metric '${path}' (must be declared in SCHEMA)`)
  }
}

const sessionFor = (sessionId) => {
  if (!sessionId) return null
  let counts = sessions.get(sessionId)
  if (!counts) {
    // Evict oldest when at capacity.
    while (sessions.size >= MAX_SESSIONS) {
      const oldest = sessions.keys().next().value
      sessions.delete(oldest)
    }
    counts = {}
    for (const key of Object.keys(SCHEMA)) counts[key] = 0
    sessions.set(sessionId, counts)
  } else {
    // Refresh LRU position.
    sessions.delete(sessionId)
    sessions.set(sessionId, counts)
  }
  return counts
}

const bump = (path, sessionId = null) => {
  assertPath(path)
  globalCounts[path]++
  const s = sessionFor(sessionId)
  if (s) s[path]++
}

const snapshot = () => ({
  startedAt: new Date(STARTED_AT).toISOString(),
  uptimeMs: Date.now() - STARTED_AT,
  global: { ...globalCounts },
  sessions: Object.fromEntries([...sessions.entries()].map(([id, c]) => [id, { ...c }]))
})

// Test seam.
const reset = () => {
  for (const key of Object.keys(globalCounts)) globalCounts[key] = 0
  sessions.clear()
}

module.exports = { bump, snapshot, reset, SCHEMA }
