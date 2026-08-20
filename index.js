require('dotenv').config()
const express = require('express')
const crypto = require('crypto')
const connectDB = require('./src/config/db')
const { chatWithMemory } = require('./src/services/memoryChatService')
const { handleJsonRpc, MEMORY_TOOLS } = require('./src/services/mcpToolService')
const { validate, chatBodySchema } = require('./src/validation/schemas')

const app = express()
app.use(express.json())

connectDB()

app.get('/', (req, res) => {
  res.json({
    name: 'megamem',
    version: '1.0.0',
    endpoints: ['/chat', '/mcp', '/mcp/sse', '/tools']
  })
})

app.post('/chat', async (req, res) => {
  try {
    const parsed = validate(chatBodySchema, req.body)

    if (!parsed.ok) {
      return res.status(400).json({ errors: parsed.errors })
    }

    const { query, sessionId, topK } = parsed.data
    const result = await chatWithMemory({ query, sessionId, topK })
    res.json(result)
  } catch (error) {
    console.error('/chat failed:', error.message)
    res.status(500).json({ error: error.message })
  }
})

app.get('/tools', (req, res) => {
  res.json({ tools: MEMORY_TOOLS })
})

app.post('/mcp', async (req, res) => {
  const body = req.body
  const response = await handleJsonRpc(body)

  if (response === null) {
    return res.status(204).send()
  }

  res.json(response)
})

const sseSessions = new Map()

app.get('/mcp/sse', (req, res) => {
  const sessionId = crypto.randomUUID()
  const messageUrl = `/mcp/messages?sessionId=${sessionId}`

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  })
  res.flushHeaders()

  res.write(`event: endpoint\ndata: ${messageUrl}\n\n`)

  sseSessions.set(sessionId, res)

  const heartbeat = setInterval(() => {
    res.write(': heartbeat\n\n')
  }, 15000)

  req.on('close', () => {
    clearInterval(heartbeat)
    sseSessions.delete(sessionId)
  })
})

app.post('/mcp/messages', async (req, res) => {
  const { sessionId } = req.query
  const stream = sseSessions.get(sessionId)

  if (!stream) {
    return res.status(404).json({ error: 'unknown session' })
  }

  try {
    const body = req.body
    const response = await handleJsonRpc(body)

    if (response !== null) {
      stream.write(`event: message\ndata: ${JSON.stringify(response)}\n\n`)
    }

    res.status(202).json({ accepted: true })
  } catch (error) {
    console.error('/mcp/messages failed:', error.message)
    res.status(500).json({ error: error.message })
  }
})

const PORT = process.env.PORT || 3000
app.listen(PORT, () => console.log(`Megamem server running on port ${PORT}`))
