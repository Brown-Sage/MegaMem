const { resolveSessionIds } = require('../../src/utils/sessionId')

const cwdFromRoots = (workspaceRoots) => (workspaceRoots && workspaceRoots[0]) || process.cwd()

const sessionLayersForWorkspace = (workspaceRoots) => {
  return resolveSessionIds(undefined, cwdFromRoots(workspaceRoots))
}

module.exports = { sessionLayersForWorkspace }
