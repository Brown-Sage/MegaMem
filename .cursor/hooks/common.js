const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

// Cursor spawns hooks without the project's environment, so MONGO_URI and the
// API keys are absent unless we load them here. Every hook entry point requires
// this module before it touches the database, which makes this the one place
// that guarantees the env is ready. Reads ~/.megamem/.env first (global
// install) and the repo .env as fallback.
const { megamemHome } = require('../../src/config/env')

const { resolveSessionIds } = require('../../src/utils/sessionId')

const cwdFromRoots = (workspaceRoots) => (workspaceRoots && workspaceRoots[0]) || process.cwd()

const sessionLayersForWorkspace = (workspaceRoots) => {
  return resolveSessionIds(undefined, cwdFromRoots(workspaceRoots))
}

const stateDir = () => path.join(megamemHome(), 'state')

// Inside the MegaMem repo the project hooks and the user-level hooks both fire
// for the same conversation, which would inject the briefing twice and run
// extraction twice. The `wx` open is an atomic exclusive create, so the first
// hook to start wins even when both are spawned at once.
const claimSessionOnce = (kind, payload) => {
  const root = (payload.workspace_roots && payload.workspace_roots[0]) || ''
  const key = `${kind}|${payload.session_id || ''}|${root}`
  const marker = path.join(stateDir(), 'hooks', crypto.createHash('sha1').update(key).digest('hex').slice(0, 16))

  try {
    fs.mkdirSync(path.dirname(marker), { recursive: true })
    fs.closeSync(fs.openSync(marker, 'wx'))
    return { claimed: true, release: () => { try { fs.unlinkSync(marker) } catch { /* already gone */ } } }
  } catch (error) {
    // Unwritable state directory is not worth losing the hook over: fail open.
    if (error.code !== 'EEXIST') return { claimed: true, release: () => { /* nothing to release */ } }
    return { claimed: false, release: () => { /* another hook owns it */ } }
  }
}

module.exports = { sessionLayersForWorkspace, stateDir, claimSessionOnce }
