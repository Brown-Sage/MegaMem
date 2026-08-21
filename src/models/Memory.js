const mongoose = require('mongoose')
const { MEMORY_TYPES } = require('../constants/memoryTypes')

const MEMORY_STATUSES = ['active', 'superseded', 'deleted']

const memorySchema = new mongoose.Schema({
  sessionId: { type: String, required: true, default: 'aryan-main' },
  text: { type: String, required: true },
  type: { type: String, enum: MEMORY_TYPES, default: 'other' },
  embedding: { type: [Number], required: true },
  status: { type: String, enum: MEMORY_STATUSES, default: 'active' },
  dedupKey: { type: String, default: '' },
  eventAt: { type: Date, default: null },
  validUntil: { type: Date, default: null },
  deletedAt: { type: Date, default: null },
  supersededBy: { type: String, default: null },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
})

memorySchema.index({ sessionId: 1, text: 1 })
memorySchema.index({ sessionId: 1, status: 1 })
memorySchema.index({ sessionId: 1, dedupKey: 1 })

module.exports = mongoose.model('Memory', memorySchema)
module.exports.MEMORY_STATUSES = MEMORY_STATUSES
