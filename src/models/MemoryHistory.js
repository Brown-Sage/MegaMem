const mongoose = require('mongoose')

const HISTORY_EVENTS = ['add', 'update', 'delete', 'noop']
const HISTORY_ACTORS = ['mcp', 'hook', 'import', 'system']

const memoryHistorySchema = new mongoose.Schema({
  memoryId: { type: String, required: true },
  sessionId: { type: String, required: true },
  event: { type: String, enum: HISTORY_EVENTS, required: true },
  oldMemory: { type: String, default: null },
  newMemory: { type: String, default: null },
  reason: { type: String, default: '' },
  actor: { type: String, enum: HISTORY_ACTORS, default: 'mcp' },
  createdAt: { type: Date, default: Date.now }
})

memoryHistorySchema.index({ memoryId: 1, createdAt: -1 })
memoryHistorySchema.index({ sessionId: 1, createdAt: -1 })

module.exports = mongoose.model('MemoryHistory', memoryHistorySchema)
