const path = require('path')
const { resolveSessionId } = require('../../src/utils/sessionId')

// Hooks run with CWD = project root. Derive the same sessionId the MCP tools
// use, so hook-injected context and MCP tool calls share one memory store.
const sessionIdForWorkspace = (workspaceRoots) => {
  const cwd = (workspaceRoots && workspaceRoots[0]) || process.cwd()
  return resolveSessionId(undefined, cwd)
}

module.exports = { sessionIdForWorkspace }
