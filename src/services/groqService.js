const Groq = require('groq-sdk')
const OpenAI = require('openai')
const { child } = require('../utils/log')

const log = child('groq')

// Lazily constructed so requiring this module never needs an API key
// (unit tests run offline). __setClient overrides everything for tests.
let overrideClient = null
const clients = new Map()

// --- Multi-provider routing ---
// All providers speak OpenAI-compatible /chat/completions and work through the
// groq-sdk client with just an apiKey/baseURL switch. Groq stays the prod
// default; MEGAMEM_LLM_PROVIDER routes eval bursts to a bigger free bucket
// (e.g. Mistral's ~1B tokens/month) without touching call sites.
const PROVIDERS = {
  groq: {
    apiKeyEnv: 'GROQ_API_KEY',
    baseURL: undefined,
    defaultModel: 'openai/gpt-oss-20b'
  },
  mistral: {
    apiKeyEnv: 'MISTRAL_API_KEY',
    baseURL: 'https://api.mistral.ai/v1',
    defaultModel: 'mistral-small-latest',
    sdk: 'openai'
  },
  cerebras: {
    apiKeyEnv: 'CEREBRAS_API_KEY',
    baseURL: 'https://api.cerebras.ai/v1',
    defaultModel: 'llama3.1-8b',
    sdk: 'openai'
  }
}

const resolveProviderName = () => {
  const requested = (process.env.MEGAMEM_LLM_PROVIDER || 'groq').toLowerCase()
  if (!PROVIDERS[requested]) {
    throw new Error(
      `Unknown MEGAMEM_LLM_PROVIDER '${requested}'. Valid: ${Object.keys(PROVIDERS).join(', ')}`
    )
  }
  return requested
}

const getProviderConfig = () => PROVIDERS[resolveProviderName()]

const getClient = () => {
  if (overrideClient) return overrideClient
  const providerName = resolveProviderName()
  if (!clients.has(providerName)) {
    const config = PROVIDERS[providerName]
    const apiKey = process.env[config.apiKeyEnv]
    if (!apiKey) {
      throw new Error(`${config.apiKeyEnv} is not set (required for provider '${providerName}')`)
    }
    // groq-sdk posts to its own /openai/v1/... path prefix, which only exists
    // on Groq — other providers get the generic OpenAI SDK pointed at their
    // OpenAI-compatible /v1 endpoint.
    clients.set(
      providerName,
      config.sdk === 'openai'
        ? new OpenAI({ apiKey, baseURL: config.baseURL, maxRetries: 0 })
        : new Groq({ apiKey, baseURL: config.baseURL })
    )
  }
  return clients.get(providerName)
}

const __setClient = (next) => { overrideClient = next }

// gpt-oss models are reasoners on Groq; other providers' models are plain
// chat models. Reasoning effort is only sent when the selected model matches.
// Resolved at call time so MEGAMEM_JUDGE_PROVIDER-style env switches work
// mid-process (see benchmarks/locomo/runEval.js).
const getDefaultModel = () => process.env.GROQ_MODEL || getProviderConfig().defaultModel

// --- Global LLM concurrency limiter (semaphore) ---
// Shared across ALL providers and every caller in-process (pipeline,
// conflict detection, judge). Sized so parallel eval workers saturate the
// provider rate limit without 429 storms; Mistral free tier allows ~30 RPM
// sustained, so 6 concurrent calls with sub-second latencies stays safe.
const MAX_CONCURRENT_GROQ = parseInt(process.env.MEGAMEM_MAX_CONCURRENT_LLM || '6', 10)
let groqRunning = 0
const groqQueue = []

const groqAcquire = () => {
  if (groqRunning < MAX_CONCURRENT_GROQ) {
    groqRunning++
    return Promise.resolve()
  }
  return new Promise((resolve) => {
    groqQueue.push({ resolve })
  })
}

const groqRelease = () => {
  groqRunning--
  if (groqQueue.length > 0) {
    const next = groqQueue.shift()
    groqRunning++
    next.resolve()
  }
}
// --- end semaphore ---

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const RETRYABLE_STATUS_CODES = new Set([408, 429, 500, 503])
const RETRYABLE_NETWORK_CODES = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'ECONNREFUSED',
  'EPIPE',
  'EAI_AGAIN'
])

const isRetryableError = (err) => {
  // Client timeout (our own timer) is not retryable
  if (err.message && err.message.includes('Groq API timeout')) {
    return false
  }

  // SDK errors with a status code
  if (err.status) {
    return RETRYABLE_STATUS_CODES.has(err.status)
  }

  // Network errors
  if (err.code && RETRYABLE_NETWORK_CODES.has(err.code)) {
    return true
  }

  // Network errors detected by message (socket hang up etc.)
  if (err.message && /socket hang up|ECONNRESET|ETIMEDOUT|ENOTFOUND/i.test(err.message)) {
    return true
  }

  return false
}

const extractRetryAfter = (err) => {
  // Groq SDK exposes retry-after on the error as a seconds value or header.
  const raw = err?.retryAfterMs || err?.headers?.['retry-after'] || err?.response?.headers?.get?.('retry-after')
  if (raw) {
    const seconds = Number(raw)
    if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000
  }

  // Fallback: parse "Please try again in 13.76s" from the error message.
  const match = /try again in ([0-9.]+)s/i.exec(err?.message || '')
  if (match) {
    const seconds = parseFloat(match[1])
    if (Number.isFinite(seconds) && seconds > 0) return Math.ceil(seconds * 1000)
  }

  return null
}

const chat = async (prompt) => {
  return completeChat([{ role: 'user', content: prompt }])
}

const RETRY_BACKOFF = [1000, 2000]

// gpt-oss models are reasoners: hidden reasoning tokens count against
// max_tokens and can truncate JSON output mid-array. 'low' effort cut
// reasoning tokens ~10x in testing while keeping extraction quality.
const isReasoningModel = (model) => /gpt-oss/i.test(model || '')

const resolveReasoningEffort = (model, requested) => {
  if (requested !== undefined) return requested
  const envEffort = process.env.MEGAMEM_REASONING_EFFORT
  if (envEffort) return envEffort
  return isReasoningModel(model) ? 'low' : undefined
}

const completeChat = async (messages, options = {}) => {
  const maxRetries = options.maxRetries ?? 2
  const timeoutMs = options.timeoutMs ?? 10000
  const model = options.model || getDefaultModel()
  let lastError

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    await groqAcquire()
    try {
      const requestBody = {
        model,
        messages,
        max_tokens: options.maxTokens || 1000,
        temperature: options.temperature ?? 0.3
      }

      const reasoningEffort = resolveReasoningEffort(model, options.reasoningEffort)
      if (reasoningEffort) requestBody.reasoning_effort = reasoningEffort

      const response = await Promise.race([
        getClient().chat.completions.create(requestBody),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error('Groq API timeout after ' + timeoutMs / 1000 + 's')),
            timeoutMs
          )
        )
      ])

      const choice = response.choices[0]
      if (choice.finish_reason === 'length') {
        log.warn({ maxTokens: requestBody.max_tokens }, 'response hit max_tokens; output may be truncated')
      }

      return choice.message.content
    } catch (err) {
      lastError = err
      if (!isRetryableError(err) || attempt === maxRetries) throw err
      log.warn({ attempt: attempt + 1, maxAttempts: maxRetries + 1, err: err.message }, 'groq retry')
    } finally {
      groqRelease()
    }

    // backoff OUTSIDE semaphore — release happens in finally, sleep happens here.
    // Respect the server's Retry-After when present.
    const retryAfter = extractRetryAfter(lastError)
    await sleep(retryAfter ?? RETRY_BACKOFF[attempt] ?? 2000)
  }

  throw lastError
}

module.exports = { chat, completeChat, isRetryableError, getDefaultModel, __setClient }
