const mongoose = require('mongoose')
const { child } = require('../utils/log')

const log = child('db')

const RETRY_DELAYS_MS = [1000, 3000, 8000]
const MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 1

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const connectDB = async () => {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      await mongoose.connect(process.env.MONGO_URI)
      log.info('MongoDB connected')
      return
    } catch (err) {
      log.warn(`connection attempt ${attempt}/${MAX_ATTEMPTS} failed: ${err.message}`)
      if (attempt < MAX_ATTEMPTS) {
        const delay = RETRY_DELAYS_MS[attempt - 1]
        log.warn(`retrying in ${delay / 1000}s...`)
        await sleep(delay)
      }
    }
  }

  log.error('MongoDB connection failed after all attempts.')
  process.exit(1)
}

module.exports = connectDB
