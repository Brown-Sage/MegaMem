const mongoose = require('mongoose')

const memorySchema = new mongoose.Schema({
  sessionId: { type: String, required: true },
  text: { type: String, required: true },
  embedding: { type: [Number], required: true },
  createdAt: { type: Date, default: Date.now }
})

module.exports = mongoose.model('Memory', memorySchema)