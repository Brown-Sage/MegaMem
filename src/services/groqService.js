const Groq = require('groq-sdk')
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY })

// llama-3.3-70b-versatile was retired by Groq. openai/gpt-oss-20b returns
// clean JSON without reasoning-token leakage, so it is the default.
const DEFAULT_MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-20b'

// --- Groq concurrency limiter (semaphore) ---
const MAX_CONCURRENT_GROQ = 3
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

const completeChat = async (messages, options = {}) => {
  const maxRetries = options.maxRetries ?? 2
  const timeoutMs = options.timeoutMs ?? 10000
  let lastError

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    await groqAcquire()
    try {
      const response = await Promise.race([
        groq.chat.completions.create({
          model: options.model || DEFAULT_MODEL,
          messages,
          max_tokens: options.maxTokens || 1000,
          temperature: options.temperature ?? 0.3
        }),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error('Groq API timeout after ' + timeoutMs / 1000 + 's')),
            timeoutMs
          )
        )
      ])

      return response.choices[0].message.content
    } catch (err) {
      lastError = err
      if (!isRetryableError(err) || attempt === maxRetries) throw err
      console.error(
        '[groq] attempt ' + (attempt + 1) + '/' + (maxRetries + 1) + ' failed, retrying: ' + err.message
      )
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

module.exports = { chat, completeChat, isRetryableError, DEFAULT_MODEL }
