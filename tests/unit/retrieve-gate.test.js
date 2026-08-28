const { test, beforeEach } = require('node:test')
const assert = require('node:assert')
const { relevanceGate, parseGateVerdict } = require('../../src/services/retrieveService')
const { __setClient } = require('../../src/services/groqService')
const { reset } = require('../../src/utils/counters')

beforeEach(() => reset())

const mockReply = (content) => __setClient({
  chat: { completions: { create: async () => ({ choices: [{ message: { content } }] }) } }
})

test('parseGateVerdict accepts leading yes/no case-insensitively', () => {
  assert.equal(parseGateVerdict('YES'), 'YES')
  assert.equal(parseGateVerdict('yes.'), 'YES')
  assert.equal(parseGateVerdict('NO'), 'NO')
  assert.equal(parseGateVerdict('no — none of them answers'), 'NO')
})

test('parseGateVerdict strips reasoner think-blocks before parsing', () => {
  assert.equal(parseGateVerdict('<think>let me think... maybe yes?</think>NO'), 'NO')
})

test('parseGateVerdict returns null for empty or ambiguous replies', () => {
  assert.equal(parseGateVerdict(''), null)
  assert.equal(parseGateVerdict(undefined), null)
  assert.equal(parseGateVerdict('unsure'), null)
  assert.equal(parseGateVerdict('The answer is YES'), null)
})

test('relevanceGate passes results on YES', async () => {
  mockReply('YES')
  const verdict = await relevanceGate('q', [{ text: 'memory one' }])
  assert.deepEqual(verdict, { gated: false, passed: true })
})

test('relevanceGate gates results on NO', async () => {
  mockReply('NO')
  const verdict = await relevanceGate('q', [{ text: 'memory one' }])
  assert.deepEqual(verdict, { gated: true })
})

test('relevanceGate strips think-blocks and gates on trailing NO', async () => {
  mockReply('<think>checking the memories...</think>NO')
  const verdict = await relevanceGate('q', [{ text: 'memory one' }])
  assert.deepEqual(verdict, { gated: true })
})

test('relevanceGate fails open on empty judge response instead of discarding results', async () => {
  mockReply('')
  const verdict = await relevanceGate('q', [{ text: 'memory one' }])
  assert.equal(verdict.gated, false)
  assert.equal(verdict.failedOpen, true)
  assert.equal(verdict.failedEmpty, true)
})

test('relevanceGate fails open on garbage judge response', async () => {
  mockReply('unsure')
  const verdict = await relevanceGate('q', [{ text: 'memory one' }])
  assert.equal(verdict.gated, false)
  assert.equal(verdict.failedOpen, true)
  assert.equal(verdict.failedEmpty, true)
})

test('relevanceGate fails open when the judge errors (no failedEmpty)', async () => {
  __setClient({
    chat: { completions: { create: async () => { throw new Error('provider down') } } }
  })
  const verdict = await relevanceGate('q', [{ text: 'memory one' }])
  assert.equal(verdict.gated, false)
  assert.equal(verdict.failedOpen, true)
  assert.equal(verdict.failedEmpty, undefined)
})