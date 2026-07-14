require('dotenv').config({ quiet: true })
const connectDB = require('./config/db')
const { handleJsonRpc } = require('./services/mcpToolService')
const readline = require('readline')

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
  console.error('MCP server failed:', error.message)
  process.exit(1)
})
