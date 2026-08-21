const { test, afterEach } = require('node:test')
const assert = require('node:assert')
const { embedText, __setEmbedder } = require('../../src/services/embedService')

afterEach(() => __setEmbedder(null))

test('embedText uses injected embedder without network', async () => {
  __setEmbedder(async (text) => [text.length, 0.5])
  const vector = await embedText('abcd')
  assert.deepEqual(vector, [4, 0.5])
})
