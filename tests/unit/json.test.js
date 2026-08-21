const { test } = require('node:test')
const assert = require('node:assert')
const { parseJsonObject } = require('../../src/utils/json')

test('parseJsonObject parses plain JSON', () => {
  assert.deepEqual(parseJsonObject('{"a":1}'), { a: 1 })
})

test('parseJsonObject strips markdown fences', () => {
  assert.deepEqual(parseJsonObject('```json\n{"a":1}\n```'), { a: 1 })
  assert.deepEqual(parseJsonObject('```\n{"a":1}\n```'), { a: 1 })
})

test('parseJsonObject extracts object from surrounding prose', () => {
  const content = 'Here you go:\n{"memories":[{"text":"fact"}]}\nDone.'
  assert.deepEqual(parseJsonObject(content), { memories: [{ text: 'fact' }] })
})

test('parseJsonObject strips think blocks before parsing', () => {
  const content = '<think>\nlet me think {"fake": true}\nabout it</think>\n{"verdicts":[{"index":0,"verdict":"YES"}]}'
  assert.deepEqual(parseJsonObject(content), { verdicts: [{ index: 0, verdict: 'YES' }] })
})

test('parseJsonObject recovers first balanced object from multiple objects', () => {
  const content = '{"verdicts":[{"index":0,"verdict":"NO"}]}\n{"stray":"trailer"}'
  assert.deepEqual(parseJsonObject(content), { verdicts: [{ index: 0, verdict: 'NO' }] })
})

test('parseJsonObject handles braces inside strings', () => {
  const content = 'prefix {"text":"has } and { inside","ok":true} suffix'
  assert.deepEqual(parseJsonObject(content), { text: 'has } and { inside', ok: true })
})

test('parseJsonObject throws with label on garbage', () => {
  assert.throws(() => parseJsonObject('no json here', 'MyStage'), /MyStage/)
  assert.throws(() => parseJsonObject(''), /invalid JSON/)
})
