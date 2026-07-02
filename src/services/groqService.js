const Groq = require('groq-sdk')
const groq = new Groq({apikey : process.env.GROQ_API_KEY})

const chat = async (prompt) => {
  const response = await groq.chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 1000
  })
  return response.choices[0].message.content
}

module.exports = { chat }