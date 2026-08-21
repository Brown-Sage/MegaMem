const { test } = require('node:test')
const assert = require('node:assert')
const {
  normalizeMemory,
  dedupeExtracted,
  buildExtractionMessages,
  MEMORY_TYPES,
  TECHNICAL_MEMORY_TYPES
} = require('../../src/services/extractionService')

test('normalizeMemory keeps valid memory and clamps numbers', () => {
  const m = normalizeMemory({ text: '  uses arch linux  ', type: 'preference', importance: 99, confidence: -1 })
  assert.equal(m.text, 'uses arch linux')
  assert.equal(m.type, 'preference')
  assert.equal(m.importance, 5)
  assert.equal(m.confidence, 0)
})

test('normalizeMemory rejects empty and oversized text', () => {
  assert.equal(normalizeMemory({ text: '   ' }), null)
  assert.equal(normalizeMemory({ text: 'x'.repeat(501) }), null)
  assert.equal(normalizeMemory({}), null)
})

test('normalizeMemory coerces unknown type to other', () => {
  assert.equal(normalizeMemory({ text: 'fact', type: 'gossip' }).type, 'other')
})

test('dedupeExtracted is whitespace/case insensitive', () => {
  const out = dedupeExtracted([
    { text: 'Uses Vim', type: 'preference' },
    { text: 'uses   vim', type: 'other' },
    { text: 'Likes tea', type: 'preference' }
  ])
  assert.equal(out.length, 2)
  assert.equal(out[0].text, 'Uses Vim')
})

test('buildExtractionMessages embeds conversation and maxMemories', () => {
  const messages = buildExtractionMessages({ conversation: 'USER: hi', maxMemories: 7 })
  assert.equal(messages.length, 2)
  assert.match(messages[1].content, /up to 7/)
  assert.match(messages[1].content, /USER: hi/)
  for (const type of MEMORY_TYPES) {
    if (type === 'other') continue
    assert.ok(messages[1].content.includes(type), `missing type ${type}`)
  }
})

test('technical types route to workspace layer', () => {
  for (const t of ['decision', 'task', 'project_context', 'constraint', 'bug']) {
    assert.ok(TECHNICAL_MEMORY_TYPES.includes(t))
  }
})
