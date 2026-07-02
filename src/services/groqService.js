const Groq = require('groq-sdk')
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY })

const chat = async (prompt) => {
  return completeChat([{ role: 'user', content: prompt }])
}

const completeChat = async (messages, options = {}) => {
  const response = await groq.chat.completions.create({
    model: options.model || 'llama-3.3-70b-versatile',
    messages,
    max_tokens: options.maxTokens || 1000,
    temperature: options.temperature ?? 0.3
  })

  return response.choices[0].message.content
}

module.exports = { chat, completeChat }
