require('dotenv').config()
const { extractMemories } = require('../src/services/extractionService')

const run = async () => {
  const memories = await extractMemories({
    conversation: [
      'User: I am building MegaMem, an MCP-first memory layer for coding assistants.',
      'Assistant: Nice. Should we keep the frontend?',
      'User: No, frontend is not the main part. This should be backend heavy.',
      'User: Also, I prefer JavaScript for this project.'
    ].join('\n')
  })

  console.log('Extracted memories:')
  memories.forEach((memory, index) => {
    console.log(`${index + 1}. [${memory.type}] ${memory.text}`)
    console.log(`   importance=${memory.importance} confidence=${memory.confidence}`)
    console.log(`   reason=${memory.reason}`)
  })
}

run()
