const CHARS_PER_TOKEN = 4

const DEFAULT_MODEL_CONTEXT_TOKENS = {
  'llama-3.3-70b-versatile': 128000,
  'llama-3.1-70b-versatile': 128000,
  'llama-3.1-8b-instant': 128000,
  'mixtral-8x7b-32768': 32768
}

const SYSTEM_OVERHEAD_TOKENS = 80

const estimateTokens = (text) => {
  if (typeof text !== 'string' || !text) return 0
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

const estimateMessageTokens = (messages = []) => {
  return messages.reduce((sum, message) => {
    const roleOverhead = 4
    return sum + estimateTokens(message.content) + roleOverhead
  }, 0)
}

const getModelContext = (model) => {
  return DEFAULT_MODEL_CONTEXT_TOKENS[model] || 8192
}

const fitMessagesToContext = ({ messages, model, maxOutputTokens = 1000, safetyMargin = 200 }) => {
  const contextWindow = getModelContext(model)
  const budget = contextWindow - maxOutputTokens - safetyMargin

  if (estimateMessageTokens(messages) <= budget) {
    return { messages, trimmed: false, droppedMemoryCount: 0 }
  }

  const systemIndex = messages.findIndex(m => m.role === 'system')
  const userIndex = messages.findIndex(m => m.role !== 'system')

  if (systemIndex === -1 || userIndex === -1) {
    return { messages, trimmed: false, droppedMemoryCount: 0 }
  }

  const systemMessage = messages[systemIndex]
  const userMessage = messages[userIndex]
  const userTokens = estimateTokens(userMessage.content) + 4
  const systemOverheadTokens = SYSTEM_OVERHEAD_TOKENS
  const availableForMemories = budget - userTokens - systemOverheadTokens

  if (availableForMemories <= 0) {
    return { messages, trimmed: false, droppedMemoryCount: 0, note: 'no_budget_for_memories' }
  }

  const match = systemMessage.content.match(/Relevant memories:\n([\s\S]*)$/)

  if (!match) {
    return { messages, trimmed: false, droppedMemoryCount: 0 }
  }

  const memoryLines = match[1].split('\n').filter(Boolean)
  const kept = []
  let usedTokens = 0
  let dropped = 0

  for (const line of memoryLines) {
    const lineTokens = estimateTokens(line) + 1
    if (usedTokens + lineTokens > availableForMemories) {
      dropped += 1
      continue
    }
    kept.push(line)
    usedTokens += lineTokens
  }

  const newMemoryBlock = kept.length > 0 ? kept.join('\n') : 'No relevant memories found.'

  const newSystemContent = systemMessage.content.replace(
    /Relevant memories:\n[\s\S]*$/,
    `Relevant memories:\n${newMemoryBlock}`
  )

  return {
    messages: [
      { role: 'system', content: newSystemContent },
      userMessage
    ],
    trimmed: true,
    droppedMemoryCount: dropped
  }
}

module.exports = {
  estimateTokens,
  estimateMessageTokens,
  fitMessagesToContext,
  getModelContext
}
