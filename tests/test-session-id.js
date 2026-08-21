const {
  resolveSessionIds,
  targetSessionId,
  userSessionId,
  workspaceSessionId,
  layerLabel
} = require('../src/utils/sessionId')

const expect = (condition, label) => {
  if (!condition) {
    console.error(`FAIL: ${label}`)
    process.exitCode = 1
  } else {
    console.log(`PASS: ${label}`)
  }
}

const prevUser = process.env.MEGAMEM_USER_ID
const prevWs = process.env.MEGAMEM_WORKSPACE_ID

process.env.MEGAMEM_USER_ID = 'user-test'
process.env.MEGAMEM_WORKSPACE_ID = 'ws-test'

console.log('--- resolveSessionIds ---')

const both = resolveSessionIds()
expect(both.userId === 'user-test', 'user id from MEGAMEM_USER_ID')
expect(both.workspaceId === 'ws-test', 'workspace id from MEGAMEM_WORKSPACE_ID')
expect(both.explicit === null, 'no explicit id when omitted')
expect(both.ids.includes('user-test') && both.ids.includes('ws-test'), 'ids include both layers')

const explicit = resolveSessionIds('mcp_test_1')
expect(explicit.ids.length === 1 && explicit.ids[0] === 'mcp_test_1', 'explicit session is single-bucket')
expect(explicit.explicit === 'mcp_test_1', 'explicit flag set')

console.log('\n--- type routing ---')

expect(targetSessionId(both, 'other') === 'user-test', 'other → user')
expect(targetSessionId(both, 'preference') === 'user-test', 'preference → user')
expect(targetSessionId(both, 'decision') === 'ws-test', 'decision → workspace')
expect(targetSessionId(both, 'project_context') === 'ws-test', 'project_context → workspace')
expect(targetSessionId(both, 'preference', 'workspace') === 'ws-test', 'scope workspace wins')
expect(targetSessionId(explicit, 'decision') === 'mcp_test_1', 'explicit ignores type routing')

expect(layerLabel('user-test', both) === 'user', 'layerLabel user')
expect(layerLabel('ws-test', both) === 'workspace', 'layerLabel workspace')
expect(userSessionId() === 'user-test', 'userSessionId')
expect(workspaceSessionId() === 'ws-test', 'workspaceSessionId')

if (prevUser === undefined) delete process.env.MEGAMEM_USER_ID
else process.env.MEGAMEM_USER_ID = prevUser
if (prevWs === undefined) delete process.env.MEGAMEM_WORKSPACE_ID
else process.env.MEGAMEM_WORKSPACE_ID = prevWs

if (process.exitCode) process.exit(process.exitCode)
