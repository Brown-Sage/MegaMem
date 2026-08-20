const mongoose = require('mongoose')

const RETRY_DELAYS_MS = [1000, 3000, 8000]
const MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 1

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const connectDB = async () => {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      await mongoose.connect(process.env.MONGO_URI)
      console.error('MongoDB connected')
      return
    } catch (err) {
      console.error(`MongoDB connection attempt ${attempt}/${MAX_ATTEMPTS} failed: ${err.message}`)
      if (attempt < MAX_ATTEMPTS) {
        const delay = RETRY_DELAYS_MS[attempt - 1]
        console.error(`Retrying in ${delay / 1000}s...`)
        await sleep(delay)
      }
    }
  }

  console.error('MongoDB connection failed after all attempts.')
  process.exit(1)
}

module.exports = connectDB
