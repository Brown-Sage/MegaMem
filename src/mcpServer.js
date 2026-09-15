require('./config/env')
const connectDB = require('./config/db')
const { handleJsonRpc } = require('./services/mcpToolService')
const { child } = require('./utils/log')
const readline = require('readline')

const log = child('mcp')

const connect = async () => {
  await connectDB()
  startStdioTransport()
}

const startStdioTransport = () => {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false
  })

  rl.on('line', async (line) => {
    const trimmed = line.trim()
    if (!trimmed) return

    try {
      const body = JSON.parse(trimmed)
      const response = await handleJsonRpc(body)
      if (response !== null) {
        process.stdout.write(JSON.stringify(response) + '\n')
      }
    } catch (error) {
      const errorResponse = {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Parse error', data: error.message }
      }
      process.stdout.write(JSON.stringify(errorResponse) + '\n')
    }
  })
}

connect().catch(error => {
  log.error({ err: error.message }, 'MCP server failed')
  process.exit(1)
})
