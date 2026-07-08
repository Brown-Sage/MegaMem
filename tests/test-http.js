require('dotenv').config()
const connectDB = require('../src/config/db')
const mongoose = require('mongoose')
const Memory = require('../src/models/Memory')

const PORT = 3777
const BASE_URL = `http://127.0.0.1:${PORT}`

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

const startServer = () => {
  return new Promise((resolve, reject) => {
    const child = require('child_process').spawn('node', ['index.js'], {
      env: { ...process.env, PORT: String(PORT) },
      stdio: ['ignore', 'pipe', 'pipe']
    })

    let started = false
    child.stdout.on('data', (data) => {
      const text = data.toString()
      if (text.includes('running on port') && !started) {
        started = true
        resolve(child)
      }
    })
    child.stderr.on('data', (data) => process.stderr.write(data))
    child.on('error', reject)

    setTimeout(() => {
      if (!started) reject(new Error('server did not start in time'))
    }, 10000)
  })
}

const httpRequest = async (method, path, body) => {
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  })
  const data = await response.json().catch(() => null)
  return { status: response.status, data }
}

const run = async () => {
  await connectDB()

  const sessionId = `http_test_${Date.now()}`
  await Memory.deleteMany({ sessionId })

  const server = await startServer()
  await sleep(500)

  try {
    console.log('--- test 1: GET / ---')
    const root = await httpRequest('GET', '/')
    console.log(`status: ${root.status}, name: ${root.data?.name}`)

    console.log('\n--- test 2: GET /tools ---')
    const tools = await httpRequest('GET', '/tools')
    console.log(`status: ${tools.status}, tools: ${tools.data?.tools?.map(t => t.name).join(', ')}`)

    console.log('\n--- test 3: POST /chat ---')
    const chat = await httpRequest('POST', '/chat', {
      query: 'I am building a CLI tool in Rust and I live in Berlin.',
      sessionId
    })
    console.log(`status: ${chat.status}`)
    console.log(`answer: ${chat.data?.answer?.slice(0, 100)}...`)
    console.log(`memories retrieved: ${chat.data?.memories?.length}`)

    await sleep(6000)

    const stored = await Memory.find({ sessionId }).select('text -_id')
    console.log(`memories stored: ${stored.length}`)
    stored.forEach(m => console.log(`  - ${m.text}`))

    console.log('\n--- test 4: POST /chat with missing fields returns 400 ---')
    const bad = await httpRequest('POST', '/chat', { query: 'hi' })
    console.log(`status: ${bad.status} (expected 400), error: ${bad.data?.error}`)

    await Memory.deleteMany({ sessionId })
  } finally {
    server.kill('SIGTERM')
    await sleep(500)
    await mongoose.disconnect()
  }
}

run().catch(error => {
  console.error(error)
  process.exit(1)
})
