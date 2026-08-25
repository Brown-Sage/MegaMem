#!/usr/bin/env node
/**
 * doctor.js — connectivity + config check for MegaMem.
 *
 * Verifies, in order (stopping at the first hard failure):
 *   1. Node version >= 18
 *   2. .env exists with the three required keys set
 *   3. MongoDB connection works (and reports self-host vs Atlas)
 *   4. Atlas Search index `vector_index` exists on `memories` and has the
 *      required filter fields (sessionId, userId) — warns if userId missing
 *   5. Hugging Face embeddings respond
 *   6. Groq chat completions respond
 *   7. End-to-end smoke test: memory_save → memory_search → memory_delete
 *      round-trip through the real MCP pipeline (isolated sessionId bucket,
 *      auto-cleanup; skipped with --skip-e2e / --skip-network or when env/Mongo
 *      aren't healthy)
 *
 * Usage: npm run doctor   (or: node scripts/doctor.js [--skip-network] [--skip-e2e])
 * Exit code 0 = all good, 1 = something needs fixing.
 */

require('dotenv').config({ quiet: true })

const fs = require('fs')
const path = require('path')

const skipNetwork = process.argv.includes('--skip-network')
const skipE2e = process.argv.includes('--skip-e2e') || skipNetwork

const OK = '  \x1b[32m✔\x1b[0m'
const BAD = '  \x1b[31m✖\x1b[0m'
const WARN = '  \x1b[33m!\x1b[0m'
let failed = false

const pass = (msg) => console.log(`${OK} ${msg}`)
const warn = (msg) => console.log(`${WARN} ${msg}`)
const fail = (msg) => { failed = true; console.log(`${BAD} ${msg}`) }

const section = (title) => console.log(`\n${title}`)

// 5 — Hugging Face embeddings
const checkHuggingFace = async () => {
  const key = process.env.HUGGINGFACE_API_KEY
  if (!key) return
  const res = await fetch(
    'https://router.huggingface.co/hf-inference/models/sentence-transformers/all-MiniLM-L6-v2/pipeline/feature-extraction',
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ inputs: 'doctor check' }),
      signal: AbortSignal.timeout(15000)
    }
  )
  if (res.ok) {
    const data = await res.json()
    const dim = Array.isArray(data) ? (Array.isArray(data[0]) ? data[0].length : null) : null
    if (dim === 384) pass('Embeddings OK (384 dims returned)')
    else if (dim) warn(`Embeddings responded but returned ${dim} dims (expected 384)`)
    else pass('Embeddings endpoint responded OK')
  } else if (res.status === 503) {
    warn('HF model is warming up (503) — key looks valid, retry in a minute')
  } else {
    fail(`Embeddings check failed: HTTP ${res.status}`)
  }
}

// 6 — Groq
const checkGroq = async () => {
  const key = process.env.GROQ_API_KEY
  if (!key) return
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: process.env.GROQ_MODEL || 'openai/gpt-oss-20b',
      messages: [{ role: 'user', content: 'Reply with OK' }],
      max_tokens: 5
    }),
    signal: AbortSignal.timeout(15000)
  })
  if (res.ok) pass('Groq chat completions OK')
  else if (res.status === 401) fail('Groq rejected the API key (401)')
  else if (res.status === 429) warn('Groq rate limited (429) — key valid but quota exhausted right now')
  else fail(`Groq check failed: HTTP ${res.status}`)
}

// 7 — End-to-end smoke test: exercise the real MCP pipeline
//     memory_save → memory_search → memory_delete against the live store.
//     Skipped automatically when Mongo/HF aren't healthy; opt out with --skip-e2e.
const callTool = async (name, args) => {
  const { handleJsonRpc } = require('../src/services/mcpToolService')
  const response = await handleJsonRpc({
    jsonrpc: '2.0', id: 1,
    method: 'tools/call',
    params: { name, arguments: args }
  })
  if (response.error) throw new Error(`${name}: ${response.error.message}`)
  const payload = JSON.parse(response.result.content[0].text)
  if (response.result.isError) throw new Error(`${name}: ${payload}`)
  return payload
}

const checkEndToEnd = async () => {
  const mongoose = require('mongoose')
  const Memory = require('../src/models/Memory')
  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 8000 })

  // Isolated bucket so the probe never touches user data.
  const SESSION_ID = `doctor-e2e-${Date.now()}`
  const TEXT = 'Doctor e2e probe fact: Ravi keeps his hiking boots in the garage loft.'

  try {
    // save — must go through dedup + conflict detection + persist
    const saved = await callTool('memory_save', { text: TEXT, sessionId: SESSION_ID })
    if (!['create', 'update'].includes(saved.action)) {
      throw new Error(`save returned action=${saved.action} (expected create/update)`)
    }
    pass(`memory_save OK (${saved.action})`)

    // search — semantic retrieval must surface it above threshold.
    // Atlas indexing can lag ~3s after write; poll briefly before failing.
    let hit = null
    for (let attempt = 1; attempt <= 5 && !hit; attempt++) {
      const found = await callTool('memory_search', {
        query: 'Where does Ravi keep his hiking boots?', topK: 5,
        sessionId: SESSION_ID
      })
      hit = (found.memories || []).find((m) => m.sessionId === SESSION_ID)
      if (!hit) await new Promise((r) => setTimeout(r, attempt * 1500))
    }
    if (!hit) fail('memory_search did not return the just-saved memory within 15s')
    else pass(`memory_search OK (score=${typeof hit.score === 'number' ? hit.score.toFixed(3) : hit.score})`)

    // delete — ownership-scoped removal must actually remove it
    const del = await callTool('memory_delete', { memoryId: saved.memoryId })
    if (!del.deleted) throw new Error('delete returned deleted=false')
    const stillThere = await Memory.countDocuments({ _id: saved.memoryId })
    if (stillThere !== 0) throw new Error('document still exists after delete')
    pass('memory_delete OK (verified gone from DB)')
  } finally {
    // Never leave probe residue behind, even on failure.
    await Memory.deleteMany({ sessionId: SESSION_ID }).catch(() => {})
    await mongoose.disconnect().catch(() => {})
  }
}

const main = async () => {
  // 1 — Node version
  section('Node')
  const major = Number(process.versions.node.split('.')[0])
  if (major >= 18) {
    pass(`Node ${process.versions.node}`)
  } else {
    fail(`Node ${process.versions.node} — MegaMem requires 18+`)
  }

  // 2 — required keys (via real environment or .env file)
  let envComplete = true
  section('Environment (.env)')
  const envPath = path.join(__dirname, '..', '.env')
  const missing = ['MONGO_URI', 'GROQ_API_KEY', 'HUGGINGFACE_API_KEY']
    .filter((k) => !process.env[k] || !String(process.env[k]).trim())

  if (!fs.existsSync(envPath) && missing.length > 0) {
    fail(`.env not found and ${missing.join(', ')} not set — copy the template: cp .env.example .env`)
    envComplete = false
  } else {
    if (fs.existsSync(envPath)) pass('.env found')
    else warn('No .env file (config comes from process environment, e.g. Docker --env-file)')
    for (const key of missing) { fail(`${key} is not set`); envComplete = false }
    for (const key of ['MONGO_URI', 'GROQ_API_KEY', 'HUGGINGFACE_API_KEY']) {
      if (!missing.includes(key)) pass(`${key} is set`)
    }
  }
  if (!process.env.MEGAMEM_USER_ID) {
    warn('MEGAMEM_USER_ID not set — memories will be owned by "default-user"')
  } else {
    pass(`MEGAMEM_USER_ID=${process.env.MEGAMEM_USER_ID}`)
  }

  // 3+4 — MongoDB / Atlas
  if (envComplete && process.env.MONGO_URI) {
    section('MongoDB')
    try {
      const mongoose = require('mongoose')
      mongoose.set('strictQuery', true)
      await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 8000 })
      const conn = mongoose.connection
      const isAtlas = /mongodb\+srv|\.mongodb\.net/.test(process.env.MONGO_URI)
      if (isAtlas) pass(`Connected to MongoDB Atlas (${conn.host})`)
      else warn(`Connected to local/self-hosted MongoDB (${conn.host}) — $vectorSearch requires Atlas, so semantic search will NOT work here`)

      // Index sanity check (only meaningful on Atlas; local mongod has no $listSearchIndexes)
      if (isAtlas) {
        try {
          const indexes = await conn.db.collection('memories').listSearchIndexes().toArray()
          const idx = indexes.find((i) => i.name === 'vector_index')
          if (!idx) {
            fail('Atlas Search index "vector_index" not found on memories — see README "Create the Atlas vector index"')
          } else {
            const fields = idx.latestDefinition?.fields || idx.definition?.fields || []
            const paths = fields.map((f) => f.path)
            const hasVector = fields.some((f) => f.type === 'vector' && f.numDimensions === 384)
            if (!hasVector) fail('vector_index is missing the 384-dim cosine embedding field')
            else pass('vector_index embedding field OK (384-dim cosine)')
            for (const p of ['sessionId', 'userId']) {
              if (paths.includes(p)) pass(`vector_index filter field "${p}" present`)
              else if (p === 'userId') warn('vector_index lacks "userId" filter field — edit the index to add it (see README). Vector search will ignore ownership until then.')
              else fail('vector_index lacks "sessionId" filter field')
            }
          }
        } catch (err) {
          warn(`Could not inspect search indexes (${err.message}) — check manually in the Atlas dashboard`)
        }
      }
      await mongoose.disconnect()
    } catch (err) {
      fail(`MongoDB connection failed: ${err.message}`)
    }
  }

  if (skipNetwork) {
    console.log('\n(--skip-network) skipping Hugging Face / Groq live checks')
  } else {
    const checks = [
      ['Hugging Face (embeddings)', checkHuggingFace],
      ['Groq (LLM)', checkGroq]
    ]
    for (const [label, fn] of checks) {
      try {
        section(label)
        await fn()
      } catch (err) {
        fail(`${label} check error: ${err.message}`)
      }
    }
  }

  // 7 — End-to-end smoke test (needs Mongo + HF embeddings; skips otherwise)
  if (!skipE2e && envComplete && process.env.MONGO_URI && process.env.HUGGINGFACE_API_KEY) {
    section('End-to-end (save → search → delete)')
    try {
      await checkEndToEnd()
    } catch (err) {
      fail(`e2e smoke test failed: ${err.message}`)
    }
  } else if (!skipE2e && !envComplete) {
    console.log('\n(End-to-end check skipped — fix the environment errors above first)')
  }

  // R1 observability — show pipeline counters. After a live e2e run these
  // must be non-zero; zero counters after real traffic means the wiring is
  // broken (the exact silent-failure mode this module exists to catch).
  section('Pipeline counters')
  const { snapshot: countersSnapshot } = require('../src/utils/counters')
  const stats = countersSnapshot()
  const active = Object.entries(stats.global).filter(([, v]) => v > 0)
  if (active.length === 0) {
    console.log(`  (no activity since ${stats.startedAt})`)
  } else {
    for (const [key, value] of active) console.log(`  ${key}: ${value}`)
  }
  if (!skipE2e && envComplete && process.env.MONGO_URI && process.env.HUGGINGFACE_API_KEY) {
    const savedCount = stats.global['saves.create'] + stats.global['saves.update']
    if (savedCount >= 1) pass('counters recorded the e2e save')
    else fail('counters did NOT record the e2e save — counter wiring is broken')
    if (stats.global['searches.count'] >= 1) pass('counters recorded the e2e search')
    else fail('counters did NOT record the e2e search — counter wiring is broken')
  }

  section('Summary')
  if (failed) {
    console.log('\nSome checks failed — fix the ✖ items above and re-run: npm run doctor\n')
    process.exit(1)
  }
  console.log('\nAll checks passed. MegaMem is ready — connect your editor via: npm run install:mcp\n')
}

main()
