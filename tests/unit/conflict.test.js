const { test } = require('node:test')
const assert = require('node:assert')
const { normalizeDecision, buildConflictMessages, normalizeCandidates } = require('../../src/services/conflictService')

test('normalizeDecision falls back to create on unknown action', () => {
  const d = normalizeDecision({ action: 'nuke' })
  assert.equal(d.action, 'create')
})

test('normalizeDecision keeps valid actions', () => {
  for (const action of ['create', 'update', 'skip', 'delete']) {
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
  assert.match(messages[0].content, /delete/)
  assert.match(messages[1].content, /targetMemoryId/)
  assert.match(messages[1].content, /create\|update\|skip\|delete/)
  assert.match(messages[1].content, /uses vim/)
  assert.match(messages[1].content, /uses emacs/)
})

test('normalizeCandidates keeps all distinct vector rows (regression: dedup keyed on undefined id)', () => {
  const vectorResults = [
    { _id: 'a', text: 'uses vim', status: 'active', score: 0.9 },
    { _id: 'b', text: 'uses emacs', status: 'active', score: 0.8 },
    { _id: 'c', text: 'uses nano', status: 'active', score: 0.7 }
  ]
  const out = normalizeCandidates({ vectorResults, unindexed: [], minScore: 0.45 })
  assert.equal(out.length, 3)
  assert.deepEqual(out.map(c => c.id), ['a', 'b', 'c'])
})

test('normalizeCandidates dedups the same memory across vector and unindexed sources', () => {
  const out = normalizeCandidates({
    vectorResults: [{ _id: 'x', text: 'uses vim', status: 'active', score: 0.9 }],
    unindexed: [{ id: 'x', text: 'uses vim', status: 'active', score: 1, recent: true }],
    minScore: 0.45
  })
  assert.equal(out.length, 1)
  assert.equal(out[0].id, 'x')
})

test('normalizeCandidates drops deleted and low-score non-recent rows', () => {
  const out = normalizeCandidates({
    vectorResults: [
      { _id: 'a', text: 'deleted', status: 'deleted', score: 0.9 },
      { _id: 'b', text: 'low score', status: 'active', score: 0.2 },
      { _id: 'c', text: 'kept', status: 'active', score: 0.8 }
    ],
    unindexed: [],
    minScore: 0.45
  })
  assert.deepEqual(out.map(c => c.id), ['c'])
})

test('normalizeCandidates keeps recent rows even when score is null', () => {
  const out = normalizeCandidates({
    vectorResults: [],
    unindexed: [{ id: 'r', text: 'recent', status: 'active', score: null, recent: true }],
    minScore: 0.45
  })
  assert.equal(out.length, 1)
  assert.equal(out[0].id, 'r')
  assert.equal(out[0].recent, true)
})

test('normalizeCandidates keeps unindexed rows carrying only id (no _id)', () => {
  const out = normalizeCandidates({
    vectorResults: [],
    unindexed: [{ id: 'solo', text: 'only id', status: 'active', score: 1, recent: true }],
    minScore: 0.45
  })
  assert.equal(out.length, 1)
  assert.equal(out[0].id, 'solo')
})
