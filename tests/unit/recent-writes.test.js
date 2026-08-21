const { test, beforeEach } = require('node:test')
const assert = require('node:assert')
const { recordWrite, checkRecentDuplicate, clear, cosineSimilarity, DUPLICATE_COSINE_THRESHOLD } = require('../../src/utils/recentWrites')

beforeEach(() => clear())

const vec = (value) => Array(8).fill(value)

test('cosineSimilarity: identical vectors are ~1', () => {
  assert.ok(Math.abs(cosineSimilarity(vec(1), vec(1)) - 1) < 1e-9)
})

test('cosineSimilarity: orthogonal vectors are 0', () => {
  assert.equal(cosineSimilarity([1, 0, 0, 0, 0, 0, 0, 0], [0, 1, 0, 0, 0, 0, 0, 0]), 0)
})

test('cosineSimilarity: mismatched lengths return 0', () => {
  assert.equal(cosineSimilarity([1, 2], [1, 2, 3]), 0)
})

test('identical dedupKey is caught as recent duplicate', () => {
  recordWrite({ sessionId: 's1', dedupKey: 'uses vim', embedding: vec(1) })
  const result = checkRecentDuplicate({ sessionId: 's1', dedupKey: 'uses vim' })
  assert.equal(result.duplicate, true)
})

test('near-identical embedding is caught even with different text', () => {
  const base = [1, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3]
  const noisy = base.map((v) => v + 0.001)
  recordWrite({ sessionId: 's1', dedupKey: 'likes tea', embedding: base })
  const result = checkRecentDuplicate({ sessionId: 's1', dedupKey: 'prefers coffee', embedding: noisy })
  assert.equal(result.duplicate, true)
  assert.match(result.reason, /Near-identical/)
})

test('different memory is not flagged', () => {
  recordWrite({ sessionId: 's1', dedupKey: 'likes tea', embedding: [1, 0, 0, 0, 0, 0, 0, 0] })
  const result = checkRecentDuplicate({
    sessionId: 's1',
    dedupKey: 'plays violin',
    embedding: [0, 1, 0, 0, 0, 0, 0, 0]
  })
  assert.equal(result.duplicate, false)
})

test('buffer is scoped per sessionId', () => {
  recordWrite({ sessionId: 's1', dedupKey: 'uses vim', embedding: vec(1) })
  const result = checkRecentDuplicate({ sessionId: 's2', dedupKey: 'uses vim' })
  assert.equal(result.duplicate, false)
})
