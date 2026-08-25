const { Router } = require('express')
const crypto = require('crypto')
const { chatWithMemory } = require('../services/memoryChatService')
const { handleJsonRpc, MEMORY_TOOLS } = require('../services/mcpToolService')
const { validate, chatBodySchema } = require('../validation/schemas')
const { HttpError, asyncRoute } = require('./errors')
const { snapshot: countersSnapshot } = require('../utils/counters')

const router = Router()

router.get('/', (req, res) => {
  res.json({
    name: 'megamem',
    version: '1.0.0',
    endpoints: ['/chat', '/mcp', '/mcp/sse', '/tools', '/stats']
  })
})

// R1 pipeline observability — in-process counters since server start.
router.get('/stats', (req, res) => {
  res.json(countersSnapshot())
})

router.post('/chat', asyncRoute(async (req, res) => {
  const parsed = validate(chatBodySchema, req.body)
  if (!parsed.ok) {
    throw new HttpError(400, 'Invalid request body', 'validation_failed', parsed.errors)
  }

  const { query, sessionId, topK } = parsed.data
  const result = await chatWithMemory({ query, sessionId, topK })
  res.json(result)
}))

router.get('/tools', (req, res) => {
  res.json({ tools: MEMORY_TOOLS })
})

router.post('/mcp', asyncRoute(async (req, res) => {
  const response = await handleJsonRpc(req.body)
  if (response === null) {
    return res.status(204).send()
  }
  res.json(response)
}))

// ---- SSE transport ----

const sseSessions = new Map()
// Bound on concurrent SSE streams so an unruly client can't exhaust fds.
const MAX_SSE_SESSIONS = Number(process.env.MEGAMEM_MAX_SSE_SESSIONS) || 50

router.get('/mcp/sse', (req, res) => {
  if (sseSessions.size >= MAX_SSE_SESSIONS) {
    return res.status(503).json({
      error: { code: 'sse_capacity', message: 'Too many active SSE sessions. Reconnect later.' }
    })
  }

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

router.post('/mcp/messages', asyncRoute(async (req, res) => {
  const { sessionId } = req.query
  const stream = typeof sessionId === 'string' ? sseSessions.get(sessionId) : undefined

  if (!stream) {
    throw new HttpError(404, 'Unknown or expired SSE session', 'unknown_session')
  }

  const response = await handleJsonRpc(req.body)
  if (response !== null) {
    stream.write(`event: message\ndata: ${JSON.stringify(response)}\n\n`)
  }
  res.status(202).json({ accepted: true })
}))

module.exports = router
