require('./src/config/env')
const express = require('express')
const connectDB = require('./src/config/db')
const { child } = require('./src/utils/log')
const routes = require('./src/http/routes')
const { rateLimit } = require('./src/http/rateLimit')
const { cors } = require('./src/http/cors')
const { notFound, errorHandler } = require('./src/http/errors')

const log = child('http')

const app = express()
app.disable('x-powered-by')

// Body size caps: /chat and MCP payloads are small; the largest legit input
// (memory_extract via HTTP) is 50KB — 1MB total covers JSON overhead + headroom
// while blocking unbounded uploads.
app.use(express.json({ limit: '1mb' }))
app.set('trust proxy', false)

app.use(cors)
app.use(rateLimit)

connectDB()

app.use('/', routes)

// JSON parse errors and unknown routes get the structured shape too.
app.use(notFound)
app.use(errorHandler)

if (require.main === module) {
  const PORT = process.env.PORT || 3000
  app.listen(PORT, () => log.info({ port: PORT }, 'Megamem server running'))
}

module.exports = { app, sseSessionsRef: () => routes }
