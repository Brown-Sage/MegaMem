const mongoose = require('mongoose')

const memorySchema = new mongoose.Schema({
  sessionId: { type: String, required: true, default: 'aryan-main' },
  text: { type: String, required: true },
  embedding: { type: [Number], required: true },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
})

memorySchema.index({ sessionId: 1, text: 1 })

module.exports = mongoose.model('Memory', memorySchema)
