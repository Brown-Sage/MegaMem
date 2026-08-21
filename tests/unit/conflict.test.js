const { test } = require('node:test')
const assert = require('node:assert')
const { normalizeDecision, buildConflictMessages } = require('../../src/services/conflictService')

test('normalizeDecision falls back to create on unknown action', () => {
  const d = normalizeDecision({ action: 'nuke' })
  assert.equal(d.action, 'create')
})

test('normalizeDecision keeps valid actions', () => {
  for (const action of ['create', 'update', 'skip']) {
    assert.equal(normalizeDecision({ action }).action, action)
  }
})

test('normalizeDecision clamps confidence into [0,1]', () => {
  assert.equal(normalizeDecision({ action: 'create', confidence: 5 }).confidence, 1)
  assert.equal(normalizeDecision({ action: 'create', confidence: -2 }).confidence, 0)
  assert.equal(normalizeDecision({ action: 'create', confidence: 0.42 }).confidence, 0.42)
})

test('normalizeDecision defaults confidence to 0.7 when missing', () => {
  assert.equal(normalizeDecision({ action: 'create' }).confidence, 0.7)
})

test('normalizeDecision trims memoryText or nulls it', () => {
  assert.equal(normalizeDecision({ action: 'create', memoryText: '  hello  ' }).memoryText, 'hello')
  assert.equal(normalizeDecision({ action: 'create', memoryText: '   ' }).memoryText, null)
  assert.equal(normalizeDecision({ action: 'create' }).memoryText, null)
})

test('normalizeDecision passes through reason and targetMemoryId', () => {
  const d = normalizeDecision({
    action: 'update',
    targetMemoryId: 'abc',
    reason: '  newer fact  '
  })
  assert.equal(d.targetMemoryId, 'abc')
  assert.equal(d.reason, 'newer fact')
})

test('buildConflictMessages includes actions and JSON shape', () => {
  const messages = buildConflictMessages({
    newMemory: { text: 'uses vim' },
    candidates: [{ id: '1', text: 'uses emacs', score: 0.9 }]
  })
  assert.equal(messages.length, 2)
  assert.equal(messages[0].role, 'system')
  assert.match(messages[0].content, /create|update|skip/)
  assert.match(messages[1].content, /targetMemoryId/)
  assert.match(messages[1].content, /uses vim/)
  assert.match(messages[1].content, /uses emacs/)
})
