const mongoose = require('mongoose')
const { DEFAULT_USER_ID } = require('../utils/ownership')

const profileSchema = new mongoose.Schema({
  // Owner of the profile — stamped server-side, mirrors Memory.userId.
  userId: { type: String, required: true, default: DEFAULT_USER_ID },
  sessionId: { type: String, required: true },
  text: { type: String, required: true },
  memoryCount: { type: Number, required: true, default: 0 },
  // Set when a memory this profile was compiled from is edited in place. A
  // rewrite leaves memoryCount unchanged, so the count-based staleness rule
  // cannot see it — without this flag a corrected memory never reaches the
  // compiled profile and the outdated claim keeps being injected.
  stale: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
})

profileSchema.index({ userId: 1, sessionId: 1 }, { unique: true })

module.exports = mongoose.model('Profile', profileSchema)
