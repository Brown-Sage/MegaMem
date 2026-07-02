require('dotenv').config()
const connectDB = require('../src/config/db')
const { saveMemory } = require('../src/services/memoryService')

const run = async () => {
  await connectDB()
  await saveMemory('I prefer JavaScript over Python', 'session_001')
  await saveMemory('I am building a RAG memory system called Megamem', 'session_001')
  await saveMemory('I am an MCA student actively looking for a job', 'session_001')
  process.exit(0)
}

run()