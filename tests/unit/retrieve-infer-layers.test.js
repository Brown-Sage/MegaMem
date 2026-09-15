const { test, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert')
const { inferLayers } = require('../../src/services/retrieveService')

const saved = {}

beforeEach(() => {
  saved.userId = process.env.MEGAMEM_USER_ID
  saved.workspaceId = process.env.MEGAMEM_WORKSPACE_ID
  delete process.env.MEGAMEM_USER_ID
  delete process.env.MEGAMEM_WORKSPACE_ID
})

afterEach(() => {
  if (saved.userId === undefined) delete process.env.MEGAMEM_USER_ID
  else process.env.MEGAMEM_USER_ID = saved.userId
  if (saved.workspaceId === undefined) delete process.env.MEGAMEM_WORKSPACE_ID
  else process.env.MEGAMEM_WORKSPACE_ID = saved.workspaceId
})

test('inferLayers takes the workspace layer from the ids it was given, not from cwd', () => {
  // Regression: a user-level Cursor hook is spawned with cwd=~/.cursor/, so
  // deriving the workspace from process.cwd() labelled genuine workspace
  // memories as [explicit] in the session briefing.
  const layers = inferLayers(['default-user', 'myproj-abc12345'])
  assert.equal(layers.userId, 'default-user')
  assert.equal(layers.workspaceId, 'myproj-abc12345')
  assert.equal(layers.explicit, null)
})

test('inferLayers does not depend on the order of the ids', () => {
  assert.equal(inferLayers(['myproj-abc12345', 'default-user']).workspaceId, 'myproj-abc12345')
})

test('inferLayers keeps single-bucket explicit behavior', () => {
  const layers = inferLayers(['locomo-eval-conv0'])
  assert.equal(layers.explicit, 'locomo-eval-conv0')
  assert.equal(layers.userId, 'locomo-eval-conv0')
  assert.equal(layers.workspaceId, 'locomo-eval-conv0')
})

test('inferLayers honors MEGAMEM_USER_ID when picking the workspace id', () => {
  process.env.MEGAMEM_USER_ID = 'alice'
  const layers = inferLayers(['alice', 'myproj-abc12345'])
  assert.equal(layers.userId, 'alice')
  assert.equal(layers.workspaceId, 'myproj-abc12345')
})

test('inferLayers falls back to the cwd-derived workspace for a user-only read', () => {
  process.env.MEGAMEM_WORKSPACE_ID = 'pinned-ws'
  const layers = inferLayers(['default-user'])
  assert.equal(layers.workspaceId, 'pinned-ws')
  assert.equal(layers.explicit, null)
})
