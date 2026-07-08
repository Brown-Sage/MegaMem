const { fitMessagesToContext, estimateTokens, estimateMessageTokens } = require('../src/utils/tokenGuard')

const buildFakeMessages = ({ memoryCount, memoryLength = 200 }) => {
  const memoryBlock = Array.from({ length: memoryCount }, (_, i) =>
    `${i + 1}. Memory ${i + 1} about something ${'x'.repeat(memoryLength)}`
  ).join('\n')

  return [
    {
      role: 'system',
      content: [
        'You are MegaMem, a memory-aware AI assistant.',
        'Use the provided memories only when they are relevant.',
        'Do not mention memory scores or internal retrieval details.',
        'If the memories are unrelated, answer normally.',
        '',
        'Relevant memories:',
        memoryBlock
      ].join('\n')
    },
    {
      role: 'user',
      content: 'What do you remember about me?'
    }
  ]
}

const run = async () => {
  console.log('--- test 1: estimateTokens is roughly chars/4 ---')
  const tokens = estimateTokens('a'.repeat(400))
  console.log(`400 chars → ${tokens} tokens (expected 100)`)

  console.log('\n--- test 2: small prompt fits without trimming ---')
  const smallMessages = buildFakeMessages({ memoryCount: 3 })
  const smallResult = fitMessagesToContext({
    messages: smallMessages,
    model: 'llama-3.3-70b-versatile'
  })
  console.log(`trimmed: ${smallResult.trimmed}, dropped: ${smallResult.droppedMemoryCount}`)

  console.log('\n--- test 3: oversized prompt trims memories ---')
  const hugeMessages = buildFakeMessages({ memoryCount: 200, memoryLength: 1500 })
  const originalTokens = estimateMessageTokens(hugeMessages)
  console.log(`original prompt: ${originalTokens} tokens`)

  const hugeResult = fitMessagesToContext({
    messages: hugeMessages,
    model: 'mixtral-8x7b-32768',
    maxOutputTokens: 1000
  })
  console.log(`trimmed: ${hugeResult.trimmed}, dropped: ${hugeResult.droppedMemoryCount} memories`)

  const newTokens = estimateMessageTokens(hugeResult.messages)
  console.log(`trimmed prompt: ${newTokens} tokens`)

  const memoryCount = (hugeResult.messages[0].content.match(/^\d+\. /gm) || []).length
  console.log(`memories kept: ${memoryCount} (out of 200)`)

  console.log('\n--- test 4: trim respects memory order (keeps top memories) ---')
  const orderedMessages = buildFakeMessages({ memoryCount: 100 })
  const orderedResult = fitMessagesToContext({
    messages: orderedMessages,
    model: 'llama-3.3-70b-versatile',
    maxOutputTokens: 1000
  })
  const keptLines = orderedResult.messages[0].content.split('\n').filter(l => /^\d+\. /.test(l))
  const firstNumber = parseInt(keptLines[0].match(/^(\d+)\. /)[1], 10)
  console.log(`first kept memory: #${firstNumber} (expected 1 if order is preserved)`)
}

run().catch(error => {
  console.error(error)
  process.exit(1)
})
