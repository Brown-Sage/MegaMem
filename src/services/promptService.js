const formatMemories = (memories = []) => {
  if (memories.length === 0) {
    return 'No relevant memories found.'
  }

  return memories
    .map((memory, index) => {
      const score = typeof memory.score === 'number'
        ? ` score=${memory.score.toFixed(3)}`
        : ''

      return `${index + 1}. ${memory.text}${score}`
    })
    .join('\n')
}

const buildPrompt = ({ query, memories = [] }) => {
  const memoryBlock = formatMemories(memories)

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
      content: query
    }
  ]
}

module.exports = { buildPrompt, formatMemories }
