const Groq = require('groq-sdk')
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY })

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

const chat = async (prompt) => {
  return completeChat([{ role: 'user', content: prompt }])
}

const completeChat = async (messages, options = {}) => {
  await groqAcquire()
  try {
    const response = await Promise.race([
      groq.chat.completions.create({
        model: options.model || 'llama-3.3-70b-versatile',
        messages,
        max_tokens: options.maxTokens || 1000,
        temperature: options.temperature ?? 0.3
      }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Groq API timeout after 30 seconds')), 30000)
      )
    ])

    return response.choices[0].message.content
  } finally {
    groqRelease()
  }
}

module.exports = { chat, completeChat }
