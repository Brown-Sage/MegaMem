require('dotenv').config()
const { chat } = require('../src/services/groqService')

const run = async () => {
  const response = await chat('say hello in one sentence')
  console.log('Groq response:', response)
}

run()