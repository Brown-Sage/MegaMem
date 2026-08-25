const { test, beforeEach } = require('node:test')
const assert = require('node:assert')
const { bump, snapshot, reset, SCHEMA } = require('../../src/utils/counters')

beforeEach(() => reset())

test('bump increments a registered metric', () => {
  bump('saves.create')
  assert.equal(snapshot().global['saves.create'], 1)
  bump('saves.create')
  assert.equal(snapshot().global['saves.create'], 2)
})

test('bump throws on unknown metric (typo guard)', () => {
  assert.throws(() => bump('save.create'), /unknown metric/)
  assert.throws(() => bump('gate.gated '), /unknown metric/)
})

test('per-session breakdown mirrors the global schema', () => {
  bump('searches.count', 'sess-1')
  bump('searches.count', 'sess-1')
  bump('searches.count', 'sess-2')
  const snap = snapshot()
  assert.equal(snap.global['searches.count'], 3)
  assert.equal(snap.sessions['sess-1']['searches.count'], 2)
  assert.equal(snap.sessions['sess-2']['searches.count'], 1)
})

test('bump without sessionId only touches global', () => {
  bump('searches.count')
  const snap = snapshot()
  assert.equal(snap.global['searches.count'], 1)
  assert.deepEqual(Object.keys(snap.sessions), [])
})

test('session map is capped (LRU eviction)', () => {
  for (let i = 0; i < 60; i++) bump('saves.skip', `sess-${i}`)
  const snap = snapshot()
  assert.ok(Object.keys(snap.sessions).length <= 50)
  assert.ok(!snap.sessions['sess-0'], 'oldest session evicted')
  assert.ok(snap.sessions['sess-59'], 'newest session retained')
})

test('touching an existing session refreshes its LRU position', () => {
  for (let i = 0; i < 50; i++) bump('saves.skip', `sess-${i}`)
  bump('saves.skip', 'sess-0') // refresh oldest
  bump('saves.skip', 'sess-new') // forces one eviction
  const snap = snapshot()
  assert.ok(snap.sessions['sess-0'], 'refreshed session survives')
  assert.ok(!snap.sessions['sess-1'], 'next-oldest evicted instead')
})

test('reset clears globals and sessions', () => {
  bump('gate.fired', 'x')
  reset()
  const snap = snapshot()
  assert.equal(snap.global['gate.fired'], 0)
  assert.deepEqual(Object.keys(snap.sessions), [])
})

test('snapshot exposes startedAt and uptimeMs', () => {
  const snap = snapshot()
  assert.ok(!Number.isNaN(Date.parse(snap.startedAt)))
  assert.ok(snap.uptimeMs >= 0)
})

test('schema covers the metrics the plan requires', () => {
  for (const key of [
    'saves.create', 'saves.update', 'saves.skip', 'saves.error',
    'searches.count',
    'gate.fired', 'gate.passed', 'gate.gated', 'gate.failedOpen',
    'extraction.runs', 'extraction.completed', 'extraction.failed',
    'extraction.skippedByWriteLog',
    'hook.errors'
  ]) {
    assert.ok(key in SCHEMA, `${key} missing from SCHEMA`)
  }
})
