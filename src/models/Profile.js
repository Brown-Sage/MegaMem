const mongoose = require('mongoose')

const profileSchema = new mongoose.Schema({
  sessionId: { type: String, required: true },
  text: { type: String, required: true },
  memoryCount: { type: Number, required: true, default: 0 },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
})

profileSchema.index({ sessionId: 1 }, { unique: true })

module.exports = mongoose.model('Profile', profileSchema)
