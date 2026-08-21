const { test } = require('node:test')
const assert = require('node:assert')
const { chunkText, dedupeChunks, DEFAULT_MAX_CHARS, DEFAULT_MAX_CHUNKS } = require('../../src/utils/chunker')

test('chunkText returns single chunk for short text', () => {
  const chunks = chunkText('hello world')
  assert.equal(chunks.length, 1)
  assert.equal(chunks[0], 'hello world')
})

test('chunkText returns empty for blank input', () => {
  assert.deepEqual(chunkText(''), [])
  assert.deepEqual(chunkText('   \n  '), [])
  assert.deepEqual(chunkText(null), [])
})

test('chunkText packs paragraphs up to maxChars', () => {
  const paragraphs = []
  for (let i = 0; i < 10; i++) paragraphs.push(`paragraph ${i} ${'x'.repeat(50)}`)
  const chunks = chunkText(paragraphs.join('\n\n'), { maxChars: 200, overlapChars: 0 })
  assert.ok(chunks.length > 1)
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 200 + 60, `chunk too long: ${chunk.length}`)
  }
})

test('chunkText hard-splits oversized paragraphs', () => {
  const bigParagraph = 'a'.repeat(1000)
  const chunks = chunkText(bigParagraph, { maxChars: 300, overlapChars: 50 })
  assert.ok(chunks.length >= 3)
  for (const chunk of chunks) assert.ok(chunk.length <= 300)
})

test('chunkText overflow merges tail chunks without data loss', () => {
  const text = Array.from({ length: 60 }, (_, i) => `para ${i} ${'y'.repeat(120)}`).join('\n\n')
  const chunks = chunkText(text, { maxChars: 200, overlapChars: 0, maxChunks: 5 })
  assert.ok(chunks.length <= 5)
  const recombined = chunks.join('\n')
  for (let i = 0; i < 60; i++) {
    assert.ok(recombined.includes(`para ${i} `), `lost para ${i}`)
  }
})

test('dedupeChunks removes whitespace/case duplicates preserving order', () => {
  const out = dedupeChunks(['Hello World', 'hello  world', 'Another'])
  assert.deepEqual(out, ['Hello World', 'Another'])
})

test('defaults are sane', () => {
  assert.equal(DEFAULT_MAX_CHARS, 6000)
  assert.equal(DEFAULT_MAX_CHUNKS, 20)
})
