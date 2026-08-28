const { child } = require('./log')

const log = child('token-guard')

const CHARS_PER_TOKEN = 4

// Context windows (tokens) keyed by model id EXACTLY as sent to the provider.
// Sources (checked 2026-08-27):
//   - Groq-hosted chat models: 128k per provider listing
//   - Cerebras public endpoints (inference-docs.cerebras.ai/models/overview):
//     gpt-oss-120b and gemma-4-31b serve 65k free / 131k paid tiers
//   - Llama 3.x: 128k native architecture spec
//   - mistral-small/large-latest: 128k (Small ≥3.1 / Large 2.x generations)
// Unknown model? Prefer the env override over editing this file:
//   MEGAMEM_MODEL_CONTEXT_<MODEL>=<tokens>
//   e.g. MEGAMEM_MODEL_CONTEXT_GPT_OSS_120B=131000 (non-alphanumerics → '_')
const DEFAULT_MODEL_CONTEXT_TOKENS = {
  'openai/gpt-oss-20b': 128000,
  'openai/gpt-oss-120b': 128000,
  'qwen/qwen3.6-27b': 128000,
  'allam-2-7b': 128000,
  'llama-3.3-70b-versatile': 128000,
  'llama-3.1-70b-versatile': 128000,
  'llama-3.1-8b-instant': 128000,
  'mixtral-8x7b-32768': 32768,
  // Multi-provider routing ids (see PROVIDERS in src/services/groqService.js)
  'mistral-small-latest': 128000,
  'mistral-large-latest': 128000,
  'gpt-oss-120b': 131000,
  'gemma-4-31b': 131000,
  'llama3.1-8b': 128000,
  'llama3.3-70b': 128000
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

// MEGAMEM_MODEL_CONTEXT_<MODEL> beats the table: 'some/new-model' →
// MEGAMEM_MODEL_CONTEXT_SOME_NEW_MODEL. Only positive finite numbers apply.
const envContextOverride = (model) => {
  const key = `MEGAMEM_MODEL_CONTEXT_${String(model || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')}`
  const value = Number(process.env[key])
  return Number.isFinite(value) && value > 0 ? value : null
}

// Unknown model = silent memory over-trimming (the exact invisible quality
// loss this module exists to prevent), so warn once per process instead of
// falling back quietly.
let warnedUnknownModel = false

const getModelContext = (model) => {
  const overridden = envContextOverride(model)
  if (overridden !== null) return overridden

  const known = DEFAULT_MODEL_CONTEXT_TOKENS[model]
  if (known !== undefined) return known

  if (!warnedUnknownModel) {
    warnedUnknownModel = true
    log.warn(
      { model },
      `unknown model '${model}' — assuming an 8192-token context window; memories will be trimmed aggressively. Set MEGAMEM_MODEL_CONTEXT_<MODEL> or add the model to DEFAULT_MODEL_CONTEXT_TOKENS.`
    )
  }
  return 8192
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
