const Memory = require('../models/Memory')
const { embedText } = require('./embedService')

const saveMemory = async (text, sessionId) => {
  const embedding = await embedText(text)
  const memory = new Memory({ sessionId, text, embedding })
  await memory.save()
  console.log('memory saved:', text)
  return memory
}

module.exports = { saveMemory }
