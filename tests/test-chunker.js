const { chunkText, dedupeChunks } = require('../src/utils/chunker')

const run = async () => {
  console.log('--- test 1: short text returns single chunk ---')
  const short = 'This is a short text.'
  const shortChunks = chunkText(short)
  console.log(`chunks: ${shortChunks.length} (expected 1)`)
  if (shortChunks.length === 1 && shortChunks[0] === short) {
    console.log('OK')
  } else {
    console.log('FAIL')
  }

  console.log('\n--- test 2: empty / non-string returns [] ---')
  const empty = chunkText('')
  const nullish = chunkText(null)
  console.log(`empty: ${empty.length} (expected 0), nullish: ${nullish.length} (expected 0)`)

  console.log('\n--- test 3: long text splits into multiple chunks with overlap ---')
  const longText = Array.from({ length: 50 }, (_, i) =>
    `Paragraph ${i + 1}. This is a test paragraph with some content to make it longer.`
  ).join('\n\n')

  const chunks = chunkText(longText, { maxChars: 800, overlapChars: 100 })
  console.log(`chunks: ${chunks.length}`)
  chunks.forEach((c, i) => console.log(`  chunk ${i + 1}: ${c.length} chars, starts with "${c.slice(0, 50)}..."`))

  const allUnder = chunks.every(c => c.length <= 900)
  console.log(`all chunks within budget: ${allUnder}`)

  console.log('\n--- test 4: paragraph boundaries preserved ---')
  const paragraphText = (
    'First paragraph about dogs. Dogs are loyal companions and have been domesticated for thousands of years.\n\n' +
    'Second paragraph about cats. Cats are independent animals that often prefer quiet indoor environments.\n\n' +
    'Third paragraph about birds. Birds can fly and many species migrate seasonally across continents.'
  )
  const paraChunks = chunkText(paragraphText, { maxChars: 150, overlapChars: 30 })
  console.log(`chunks: ${paraChunks.length}`)
  paraChunks.forEach((c, i) => console.log(`  chunk ${i + 1}: "${c.slice(0, 80)}..."`))

  console.log('\n--- test 5: dedupeChunks removes duplicates ---')
  const dupes = ['hello world', 'hello world  ', '  HELLO WORLD', 'goodbye world', 'hello world']
  const deduped = dedupeChunks(dupes)
  console.log(`input: ${dupes.length}, output: ${deduped.length} (expected 2)`)
  deduped.forEach((d, i) => console.log(`  ${i + 1}. "${d}"`))

  console.log('\n--- test 6: real long conversation chunked for extraction ---')
  const conversation = Array.from({ length: 200 }, (_, i) => `User: turn ${i + 1}`).join('\n')
  const conversationChunks = chunkText(conversation, { maxChars: 2000, overlapChars: 200 })
  console.log(`conversation length: ${conversation.length}, chunks: ${conversationChunks.length}`)
  conversationChunks.forEach((c, i) => {
    console.log(`  chunk ${i + 1}: ${c.length} chars`)
  })
}

run().catch(error => {
  console.error(error)
  process.exit(1)
})
