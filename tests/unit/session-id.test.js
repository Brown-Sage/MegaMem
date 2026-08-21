const { test, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert')
const {
  DEFAULT_SESSION_ID,
  userSessionId,
  workspaceSessionId,
  resolveSessionIds,
  targetSessionId,
  layerLabel
} = require('../../src/utils/sessionId')

const savedEnv = {}

beforeEach(() => {
  savedEnv.userId = process.env.MEGAMEM_USER_ID
  savedEnv.workspaceId = process.env.MEGAMEM_WORKSPACE_ID
  delete process.env.MEGAMEM_USER_ID
  delete process.env.MEGAMEM_WORKSPACE_ID
})

afterEach(() => {
  if (savedEnv.userId === undefined) delete process.env.MEGAMEM_USER_ID
  else process.env.MEGAMEM_USER_ID = savedEnv.userId
  if (savedEnv.workspaceId === undefined) delete process.env.MEGAMEM_WORKSPACE_ID
  else process.env.MEGAMEM_WORKSPACE_ID = savedEnv.workspaceId
})

test('userSessionId defaults to default-user', () => {
  assert.equal(userSessionId(), 'default-user')
  assert.equal(DEFAULT_SESSION_ID, 'default-user')
})

test('userSessionId honors MEGAMEM_USER_ID', () => {
  process.env.MEGAMEM_USER_ID = 'alice'
  assert.equal(userSessionId(), 'alice')
})

test('workspaceSessionId is deterministic per cwd and env-overridable', () => {
  const a = workspaceSessionId('/tmp/opencode')
  const b = workspaceSessionId('/tmp/opencode')
  const c = workspaceSessionId('/tmp/other')
  assert.equal(a, b)
  assert.notEqual(a, c)
  assert.match(a, /^opencode-[0-9a-f]{8}$/)

  process.env.MEGAMEM_WORKSPACE_ID = 'custom-ws'
  assert.equal(workspaceSessionId(), 'custom-ws')
})

test('resolveSessionIds with explicit id collapses both layers onto it', () => {
  const layers = resolveSessionIds('my-session')
  assert.equal(layers.explicit, 'my-session')
  assert.deepEqual(layers.ids, ['my-session'])
})

test('resolveSessionIds default returns distinct user + workspace layers', () => {
  process.env.MEGAMEM_USER_ID = 'default-user'
  const layers = resolveSessionIds(undefined, '/tmp/opencode')
  assert.equal(layers.explicit, null)
  assert.equal(layers.ids.length, 2)
  assert.ok(layers.ids.includes('default-user'))
  assert.ok(layers.ids.includes(layers.workspaceId))
})

test('targetSessionId routes technical types to workspace', () => {
  process.env.MEGAMEM_USER_ID = 'u1'
  const layers = resolveSessionIds(undefined, '/tmp/opencode')
  assert.equal(targetSessionId(layers, 'decision'), layers.workspaceId)
  assert.equal(targetSessionId(layers, 'bug'), layers.workspaceId)
  assert.equal(targetSessionId(layers, 'preference'), layers.userId)
  assert.equal(targetSessionId(layers, 'other'), layers.userId)
})

test('targetSessionId scope overrides type routing', () => {
  process.env.MEGAMEM_USER_ID = 'u1'
  const layers = resolveSessionIds(undefined, '/tmp/opencode')
  assert.equal(targetSessionId(layers, 'decision', 'user'), layers.userId)
  assert.equal(targetSessionId(layers, 'preference', 'workspace'), layers.workspaceId)
})

test('targetSessionId explicit beats everything', () => {
  const layers = resolveSessionIds('explicit-session')
  assert.equal(targetSessionId(layers, 'decision', 'user'), 'explicit-session')
})

test('layerLabel distinguishes layers', () => {
  process.env.MEGAMEM_USER_ID = 'u1'
  const layers = resolveSessionIds(undefined, '/tmp/opencode')
  assert.equal(layerLabel(layers.userId, layers), 'user')
  assert.equal(layerLabel(layers.workspaceId, layers), 'workspace')
  assert.equal(layerLabel('unknown', layers), 'explicit')
})
