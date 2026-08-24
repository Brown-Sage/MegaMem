const Memory = require('../models/Memory')
const MemoryHistory = require('../models/MemoryHistory')
const { embedText } = require('./embedService')
const { computeDedupKey } = require('../utils/dedupKey')
const { currentUserId } = require('../utils/ownership')
const { child } = require('../utils/log')
const { MEMORY_TYPES } = require('../constants/memoryTypes')

const log = child('memory')

const normalizeType = (type) => (MEMORY_TYPES.includes(type) ? type : 'other')

const clampNumber = (value, min, max, fallback) => {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

const normalizeImportance = (value) => clampNumber(value, 1, 5, 3)
const normalizeConfidence = (value) => clampNumber(value, 0, 1, 0.7)

const recordHistory = ({ memoryId, sessionId, event, oldMemory = null, newMemory = null, reason = '', actor = 'mcp' }) =>
  MemoryHistory.create({
    memoryId: String(memoryId),
    sessionId,
    event,
    oldMemory,
    newMemory,
    reason,
    actor
  }).catch((err) => log.warn({ err: err.message, memoryId, event }, 'history write failed'))

const saveMemory = async (text, sessionId, type = 'other', { actor = 'mcp', eventAt = null, embedding = null, importance = null, confidence = null } = {}) => {
  const vector = embedding || await embedText(text)
  const memory = new Memory({
    userId: currentUserId(),
    sessionId,
    text,
    type: normalizeType(type),
    embedding: vector,
    dedupKey: computeDedupKey(text),
    eventAt: eventAt || undefined,
    importance: importance != null ? normalizeImportance(importance) : undefined,
    confidence: confidence != null ? normalizeConfidence(confidence) : undefined
  })
  await memory.save()
  await recordHistory({
    memoryId: memory._id,
    sessionId,
    event: 'add',
    newMemory: memory.text,
    actor
  })
  log.info({ sessionId, type: memory.type }, 'memory saved')
  return memory
}

const updateMemory = async (memoryId, text, type, { actor = 'mcp', embedding = null, eventAt = null, importance = null, confidence = null } = {}) => {
  const existing = await Memory.findOne({ _id: memoryId, userId: currentUserId() })
  if (!existing) {
    throw new Error(`Memory not found for update: ${memoryId}`)
  }

  const previousText = existing.text

  existing.text = text
  existing.embedding = embedding || await embedText(text)
  existing.dedupKey = computeDedupKey(text)
  existing.updatedAt = new Date()
  if (type !== undefined) {
    existing.type = normalizeType(type)
  }
  if (eventAt) {
    existing.eventAt = eventAt
  }
  if (importance != null) {
    existing.importance = normalizeImportance(importance)
  }
  if (confidence != null) {
    existing.confidence = normalizeConfidence(confidence)
  }

  await existing.save()
  await recordHistory({
    memoryId,
    sessionId: existing.sessionId,
    event: 'update',
    oldMemory: previousText,
    newMemory: existing.text,
    actor
  })
  log.info({ memoryId }, 'memory updated')
  return existing
}

// Soft-delete: keeps the document retrievable by id (audit/undo) while every
// read path filters on status:'active'.
const deleteMemory = async (memoryId, { reason = '', actor = 'mcp' } = {}) => {
  const memory = await Memory.findOneAndUpdate(
    { _id: memoryId, userId: currentUserId() },
    {
      status: 'deleted',
      deletedAt: new Date(),
      validUntil: new Date(),
      updatedAt: new Date()
    },
    { returnDocument: 'after' }
  )

  if (!memory) {
    throw new Error(`Memory not found for delete: ${memoryId}`)
  }

  await recordHistory({
    memoryId,
    sessionId: memory.sessionId,
    event: 'delete',
    oldMemory: memory.text,
    reason,
    actor
  })
  log.info({ memoryId, reason }, 'memory deleted')
  return memory
}

const applyMemoryDecision = async ({
  decision,
  sessionId,
  fallbackText,
  type,
  eventAt = null,
  importance = null,
  confidence = null,
  minConfidence = 0.75,
  actor = 'mcp'
}) => {
  if (!decision || !decision.action) {
    throw new Error('applyMemoryDecision requires a decision')
  }

  if (decision.action === 'skip') {
    return {
      action: 'skip',
      memory: null,
      reason: decision.reason || 'Memory was skipped.'
    }
  }

  const text = decision.memoryText || fallbackText

  if (!text || typeof text !== 'string' || !text.trim()) {
    throw new Error('applyMemoryDecision requires memory text')
  }

  const resolvedType = type !== undefined
    ? type
    : (typeof decision.type === 'string' ? decision.type : 'other')

  if (decision.action === 'update') {
    if (!decision.targetMemoryId) {
      throw new Error('Update decision requires targetMemoryId')
    }

    if (decision.confidence < minConfidence) {
      return {
        action: 'skip',
        memory: null,
        reason: `Update confidence ${decision.confidence} is below ${minConfidence}.`
      }
    }

    return {
      action: 'update',
      memory: await updateMemory(decision.targetMemoryId, text.trim(), resolvedType, { actor, eventAt, importance, confidence }),
      reason: decision.reason || 'Memory updated.'
    }
  }

  if (decision.action === 'delete') {
    if (!decision.targetMemoryId) {
      throw new Error('Delete decision requires targetMemoryId')
    }

    const deleted = await deleteMemory(decision.targetMemoryId, {
      reason: decision.reason || '',
      actor
    })

    // A delete decision may also carry replacement text worth keeping.
    let created = null
    if (decision.memoryText && decision.memoryText.trim() &&
        computeDedupKey(decision.memoryText) !== deleted.dedupKey) {
      created = await saveMemory(decision.memoryText.trim(), sessionId, resolvedType, { actor, eventAt, importance, confidence })
    }

    return {
      action: 'delete',
      memory: created || deleted,
      deletedMemory: deleted,
      reason: decision.reason || 'Contradicted memory removed.'
    }
  }

  return {
    action: 'create',
    memory: await saveMemory(text.trim(), sessionId, resolvedType, { actor, eventAt, importance, confidence }),
    reason: decision.reason || 'Memory created.'
  }
}

module.exports = {
  saveMemory,
  updateMemory,
  deleteMemory,
  applyMemoryDecision,
  recordHistory
}
