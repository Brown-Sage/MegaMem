const Memory = require('../models/Memory')
const { embedText } = require('./embedService')

const saveMemory = async (text, sessionId) => {
  const embedding = await embedText(text)
  const memory = new Memory({ sessionId, text, embedding })
  await memory.save()
  console.error('memory saved:', text)
  return memory
}

const updateMemory = async (memoryId, text) => {
  const embedding = await embedText(text)

  const memory = await Memory.findByIdAndUpdate(
    memoryId,
    {
      text,
      embedding,
      updatedAt: new Date()
    },
    { returnDocument: 'after' }
  )

  if (!memory) {
    throw new Error(`Memory not found for update: ${memoryId}`)
  }

  console.error('memory updated:', text)
  return memory
}

const applyMemoryDecision = async ({ decision, sessionId, fallbackText, minConfidence = 0.75 }) => {
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
      memory: await updateMemory(decision.targetMemoryId, text.trim()),
      reason: decision.reason || 'Memory updated.'
    }
  }

  return {
    action: 'create',
    memory: await saveMemory(text.trim(), sessionId),
    reason: decision.reason || 'Memory created.'
  }
}

module.exports = {
  saveMemory,
  updateMemory,
  applyMemoryDecision
}
