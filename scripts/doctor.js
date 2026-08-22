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
 *
 * Usage: npm run doctor   (or: node scripts/doctor.js [--skip-network])
 * Exit code 0 = all good, 1 = something needs fixing.
 */

require('dotenv').config({ quiet: true })

const fs = require('fs')
const path = require('path')

const skipNetwork = process.argv.includes('--skip-network')

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

  section('Summary')
  if (failed) {
    console.log('\nSome checks failed — fix the ✖ items above and re-run: npm run doctor\n')
    process.exit(1)
  }
  console.log('\nAll checks passed. MegaMem is ready — connect your editor via: npm run install:mcp\n')
}

main()
