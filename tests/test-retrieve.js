require('dotenv').config()
const connectDB = require('../src/config/db')
const { retrieveMemory } = require('../src/services/retrieveService')

const run = async () => {
  await connectDB()
  const results = await retrieveMemory('programming language preference', 'session_001')
  console.log('Retrieved memories:')
  results.forEach(r => console.log(`[${r.score.toFixed(3)}] ${r.text}`))
  process.exit(0)
}

run()