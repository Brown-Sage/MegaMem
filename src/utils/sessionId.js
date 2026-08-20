const path = require('path')
const crypto = require('crypto')

const DEFAULT_SESSION_ID = 'aryan-main'

const workspaceSessionId = (cwd = process.cwd()) => {
  const base = path.basename(cwd)
  const hash = crypto.createHash('sha1').update(cwd).digest('hex').slice(0, 8)
  return `${base}-${hash}`
}

const resolveSessionId = (explicit, cwd) => {
  if (explicit) return explicit
  if (process.env.MEGAMEM_SESSION_ID) return process.env.MEGAMEM_SESSION_ID
  return workspaceSessionId(cwd) || DEFAULT_SESSION_ID
}

module.exports = {
  workspaceSessionId,
  resolveSessionId,
  DEFAULT_SESSION_ID
}
