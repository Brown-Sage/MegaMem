const { test } = require('node:test')
const assert = require('node:assert')
const { estimateTokens, estimateMessageTokens, fitMessagesToContext, getModelContext } = require('../../src/utils/tokenGuard')

test('estimateTokens uses 4 chars per token', () => {
  assert.equal(estimateTokens('abcd'), 1)
  assert.equal(estimateTokens('abcde'), 2)
  assert.equal(estimateTokens(''), 0)
  assert.equal(estimateTokens(null), 0)
})

test('getModelContext falls back to 8192 for unknown models', () => {
  assert.equal(getModelContext('openai/gpt-oss-20b'), 128000)
  assert.equal(getModelContext('totally-unknown'), 8192)
})

test('fitMessagesToContext is a no-op when under budget', () => {
  const messages = [
    { role: 'system', content: 'Relevant memories:\n1. small memory' },
    { role: 'user', content: 'hi' }
  ]
  const result = fitMessagesToContext({ messages, model: 'openai/gpt-oss-20b' })
  assert.equal(result.trimmed, false)
  assert.equal(result.droppedMemoryCount, 0)
})

test('fitMessagesToContext drops memory lines that exceed budget', () => {
  const bigMemory = 'M'.repeat(400000)
  const messages = [
    { role: 'system', content: `Relevant memories:\n1. ${bigMemory}\n2. tiny keeper` },
    { role: 'user', content: 'q'.repeat(100) }
  ]
  const result = fitMessagesToContext({ messages, model: 'mixtral-8x7b-32768', maxOutputTokens: 1000 })
  assert.equal(result.trimmed, true)
  assert.ok(result.droppedMemoryCount >= 1)
  const systemContent = result.messages[0].content
  assert.ok(!systemContent.includes(bigMemory))
})

test('fitMessagesToContext handles missing memory block gracefully', () => {
  const messages = [
    { role: 'system', content: 'no memories here' },
    { role: 'user', content: 'z'.repeat(50000) }
  ]
  const result = fitMessagesToContext({ messages, model: 'mixtral-8x7b-32768' })
  assert.equal(result.trimmed, false)
})

test('getModelContext knows multi-provider model windows', () => {
  assert.equal(getModelContext('mistral-small-latest'), 128000)
  assert.equal(getModelContext('mistral-large-latest'), 128000)
  assert.equal(getModelContext('gpt-oss-120b'), 131000)
  assert.equal(getModelContext('gemma-4-31b'), 131000)
  assert.equal(getModelContext('openai/gpt-oss-20b'), 128000)
})

test('MEGAMEM_MODEL_CONTEXT_<MODEL> overrides any known window', () => {
  process.env.MEGAMEM_MODEL_CONTEXT_MISTRAL_SMALL_LATEST = '32000'
  try {
    assert.equal(getModelContext('mistral-small-latest'), 32000)
  } finally {
    delete process.env.MEGAMEM_MODEL_CONTEXT_MISTRAL_SMALL_LATEST
  }
})

test('env override also works for models unknown to the table', () => {
  process.env.MEGAMEM_MODEL_CONTEXT_SOME_NEW_MODEL = '999999'
  try {
    assert.equal(getModelContext('some/new-model'), 999999)
  } finally {
    delete process.env.MEGAMEM_MODEL_CONTEXT_SOME_NEW_MODEL
  }
})

test('unknown model still falls back to the safe 8192 default', () => {
  assert.equal(getModelContext('totally-unknown-model-xyz'), 8192)
})
