const Memory = require('../models/Memory')
const { embedText } = require('./embedService')
const { log } = require('../utils/log')
const { MEMORY_TYPES } = require('../constants/memoryTypes')

const normalizeType = (type) => (MEMORY_TYPES.includes(type) ? type : 'other')

const saveMemory = async (text, sessionId, type = 'other') => {
  const embedding = await embedText(text)
  const memory = new Memory({
    sessionId,
    text,
    type: normalizeType(type),
    embedding
  })
  await memory.save()
  log('memory saved:', text)
  return memory
}

const updateMemory = async (memoryId, text, type) => {
  const embedding = await embedText(text)
  const update = {
    text,
    embedding,
    updatedAt: new Date()
  }

  if (type !== undefined) {
    update.type = normalizeType(type)
  }

  const memory = await Memory.findByIdAndUpdate(
    memoryId,
    update,
    { returnDocument: 'after' }
  )

  if (!memory) {
    throw new Error(`Memory not found for update: ${memoryId}`)
  }

  log('memory updated:', text)
  return memory
}

const applyMemoryDecision = async ({
  decision,
  sessionId,
  fallbackText,
  type,
  minConfidence = 0.75
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
      memory: await updateMemory(decision.targetMemoryId, text.trim(), resolvedType),
      reason: decision.reason || 'Memory updated.'
    }
  }

  return {
    action: 'create',
    memory: await saveMemory(text.trim(), sessionId, resolvedType),
    reason: decision.reason || 'Memory created.'
  }
}

module.exports = {
  saveMemory,
  updateMemory,
  applyMemoryDecision
}
