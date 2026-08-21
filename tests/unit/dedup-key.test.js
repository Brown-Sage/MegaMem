const { test } = require('node:test')
const assert = require('node:assert')
const { computeDedupKey } = require('../../src/utils/dedupKey')

test('dedupKey is case and whitespace insensitive', () => {
  assert.equal(computeDedupKey('Uses  Vim'), computeDedupKey('uses vim'))
  assert.equal(computeDedupKey('  Aryan   uses   arch '), 'aryan uses arch')
})

test('dedupKey strips punctuation', () => {
  assert.equal(computeDedupKey('Uses Vim!'), computeDedupKey('uses vim'))
  assert.equal(computeDedupKey("Melanie's pottery, right?"), 'melanie s pottery right')
})

test('dedupKey keeps unicode letters and numbers', () => {
  assert.equal(computeDedupKey('Café #42'), 'café 42')
})

test('dedupKey handles empty input', () => {
  assert.equal(computeDedupKey(''), '')
  assert.equal(computeDedupKey('!!!'), '')
})
