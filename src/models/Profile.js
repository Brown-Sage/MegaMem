const mongoose = require('mongoose')
const { DEFAULT_USER_ID } = require('../utils/ownership')

const profileSchema = new mongoose.Schema({
  // Owner of the profile — stamped server-side, mirrors Memory.userId.
  userId: { type: String, required: true, default: DEFAULT_USER_ID },
  sessionId: { type: String, required: true },
  text: { type: String, required: true },
  memoryCount: { type: Number, required: true, default: 0 },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
})

profileSchema.index({ userId: 1, sessionId: 1 }, { unique: true })

module.exports = mongoose.model('Profile', profileSchema)
