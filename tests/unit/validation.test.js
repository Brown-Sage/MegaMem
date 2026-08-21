const { test } = require('node:test')
const assert = require('node:assert')
const {
  validate,
  chatBodySchema,
  toolArgsSchema,
  MEMORY_SAVE_MAX_CHARS,
  MEMORY_EXTRACT_MAX_CHARS
} = require('../../src/validation/schemas')

test('chatBodySchema accepts a valid body', () => {
  const r = validate(chatBodySchema, { query: 'hello', sessionId: 's1', topK: 3 })
  assert.equal(r.ok, true)
  assert.equal(r.data.topK, 3)
})

test('chatBodySchema rejects unknown fields (strict)', () => {
  const r = validate(chatBodySchema, { query: 'hi', evil: true })
  assert.equal(r.ok, false)
  assert.ok(r.errors.some((e) => /evil/.test(e.message)))
})

test('memory_save enforces max chars and valid type', () => {
  const ok = validate(toolArgsSchema.memory_save, { text: 'a fact' })
  assert.equal(ok.ok, true)

  const tooLong = validate(toolArgsSchema.memory_save, { text: 'x'.repeat(MEMORY_SAVE_MAX_CHARS + 1) })
  assert.equal(tooLong.ok, false)

  const badType = validate(toolArgsSchema.memory_save, { text: 'fact', type: 'gossip' })
  assert.equal(badType.ok, false)

  const goodType = validate(toolArgsSchema.memory_save, { text: 'fact', type: 'decision', scope: 'workspace' })
  assert.equal(goodType.ok, true)
})

test('memory_delete requires a 24-char ObjectId', () => {
  assert.equal(validate(toolArgsSchema.memory_delete, { memoryId: 'nope' }).ok, false)
  assert.equal(validate(toolArgsSchema.memory_delete, { memoryId: 'a'.repeat(24) }).ok, true)
})

test('memory_list validates cursor and limit bounds', () => {
  assert.equal(validate(toolArgsSchema.memory_list, {}).ok, true)
  assert.equal(validate(toolArgsSchema.memory_list, { limit: 500 }).ok, false)
  assert.equal(validate(toolArgsSchema.memory_list, { cursor: 'z'.repeat(24) }).ok, false)
})

test('memory_search bounds topK', () => {
  assert.equal(validate(toolArgsSchema.memory_search, { query: 'q', topK: 50 }).ok, false)
  assert.equal(validate(toolArgsSchema.memory_search, { query: 'q', topK: 5 }).ok, true)
})

test('extract limit constant is enforced by schema', () => {
  const r = validate(toolArgsSchema.memory_extract, { text: 'x'.repeat(MEMORY_EXTRACT_MAX_CHARS + 1) })
  assert.equal(r.ok, false)
})
