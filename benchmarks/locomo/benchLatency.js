#!/usr/bin/env node
/**
 * benchLatency.js — retrieval latency benchmark (measurement only, read-only)
 *
 * Fires real retrieval queries against an existing MegaMem session store and
 * reports p50/p95/p99 latency for each pipeline stage:
 *   - embed:    query → 384-dim vector (Hugging Face API)
 *   - search:   vector + lexical channels + fusion (retrieveMemory with gate OFF)
 *   - gate:     LLM relevance gate (retrieval with gate ON minus without)
 *   - total:    full retrieveMemory call with gate ON
 *
 * Purpose: fusion widened the candidate pools (topK×4 vector, numCandidates
 * max(100, topK×20)) — this measures whether that hurt tail latency at
 * real-world store scale (~200 memories/conversation).
 *
 * USAGE:
 *   npm run eval:latency -- --session-id locomo-eval-conv0-official
 *   npm run eval:latency -- --session-id <id> --n 30 --topk 5
 *   npm run eval:latency -- --all-convs          # all official conv stores
 *   npm run eval:latency -- --skip-gate          # skip the LLM gate stage (free)
 *
 * Requires the store to already exist (ingest via eval:locomo first).
 */

const path = require('path')
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') })
const fs = require('fs')
const mongoose = require('mongoose')

const Memory = require('../../src/models/Memory')
const { retrieveMemory } = require('../../src/services/retrieveService')

// ---------- args ----------
const getFlag = (name) => {
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`))
  if (eq) return eq.split('=')[1]
  const idx = process.argv.indexOf(`--${name}`)
  if (idx !== -1 && process.argv[idx + 1] && !process.argv[idx + 1].startsWith('--')) {
    return process.argv[idx + 1]
  }
  return null
}
const hasFlag = (name) => process.argv.includes(`--${name}`)

const N = Math.max(1, parseInt(getFlag('n') || '20', 10))
const TOP_K = parseInt(getFlag('topk') || '5', 10)
const SKIP_GATE = hasFlag('skip-gate')
const RESULTS_DIR = path.join(__dirname, '..', 'results')

const percentile = (values, p) => {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  return sorted[idx]
}

// Sample real memory texts as queries when no question bank is available.
// These are in-domain (they come from the store itself), which is what we
// want: they exercise the same retrieval paths real questions do.
const sampleQueries = async (sessionId, n) => {
  const docs = await Memory.aggregate([
    { $match: { sessionId, status: 'active' } },
    { $sample: { size: n } },
    { $project: { text: 1, _id: 0 } }
  ])
  return docs.map(d => d.text.slice(0, 200))
}

const timeOne = async (fn) => {
  const t0 = Date.now()
  await fn()
  return Date.now() - t0
}

const benchSession = async (sessionId) => {
  const count = await Memory.countDocuments({ sessionId, status: 'active' })
  if (count === 0) {
    console.log(`[${sessionId}] EMPTY STORE — skipping`)
    return null
  }

  const queries = await sampleQueries(sessionId, N)
  console.log(`\n[${sessionId}] ${count} memories, ${queries.length} queries, topK=${TOP_K}${SKIP_GATE ? ' (gate skipped)' : ''}`)

  // warm-up: first-call costs (TLS handshake, model load) would skew percentiles
  await retrieveMemory(queries[0], sessionId, TOP_K, undefined, { relevanceGate: false })

  const embedMs = []
  const searchMs = []
  const totalGatedMs = []

  for (let i = 0; i < queries.length; i++) {
    const q = queries[i]

    // Stage timings come from two full runs: gate-off (search path only) and,
    // unless --skip-gate, gate-on (full pipeline). Embed is measured directly.
    const { embedText } = require('../../src/services/embedService')
    let emb
    embedMs.push(await timeOne(async () => { emb = await embedText(q) }))

    searchMs.push(await timeOne(() =>
      retrieveMemory(q, sessionId, TOP_K, undefined, { relevanceGate: false })
    ))

    if (!SKIP_GATE) {
      totalGatedMs.push(await timeOne(() =>
        retrieveMemory(q, sessionId, TOP_K, undefined, { relevanceGate: true })
      ))
    }
    process.stdout.write(`  ${i + 1}/${queries.length}\r`)
  }
  console.log('')

  const report = {
    sessionId,
    memoryCount: count,
    queries: queries.length,
    topK: TOP_K,
    embed: { p50: Math.round(percentile(embedMs, 50)), p95: Math.round(percentile(embedMs, 95)), p99: Math.round(percentile(embedMs, 99)) },
    searchNoGate: { p50: Math.round(percentile(searchMs, 50)), p95: Math.round(percentile(searchMs, 95)), p99: Math.round(percentile(searchMs, 99)) },
    totalWithGate: SKIP_GATE ? null : {
      p50: Math.round(percentile(totalGatedMs, 50)),
      p95: Math.round(percentile(totalGatedMs, 95)),
      p99: Math.round(percentile(totalGatedMs, 99))
    },
    gateCostP50: SKIP_GATE ? null : Math.round(percentile(totalGatedMs, 50) - percentile(searchMs, 50))
  }

  console.log(`  embed         p50=${report.embed.p50}ms  p95=${report.embed.p95}ms  p99=${report.embed.p99}ms`)
  console.log(`  search        p50=${report.searchNoGate.p50}ms  p95=${report.searchNoGate.p95}ms  p99=${report.searchNoGate.p99}ms  (no gate)`)
  if (!SKIP_GATE) {
    console.log(`  total+gate    p50=${report.totalWithGate.p50}ms  p95=${report.totalWithGate.p95}ms  p99=${report.totalWithGate.p99}ms`)
    console.log(`  gate cost ≈   p50=${report.gateCostP50}ms`)
  }
  return report
}

const main = async () => {
  const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI
  if (!mongoUri) throw new Error('No MONGO_URI or MONGODB_URI found in .env')
  await mongoose.connect(mongoUri)

  let targets
  if (hasFlag('all-convs')) {
    targets = Array.from({ length: 10 }, (_, i) => `locomo-eval-conv${i}-official`)
  } else {
    const sid = getFlag('session-id')
    if (!sid) throw new Error('Provide --session-id <id> or --all-convs')
    targets = [sid]
  }

  const reports = []
  for (const sessionId of targets) {
    try {
      const r = await benchSession(sessionId.trim())
      if (r) reports.push(r)
    } catch (err) {
      console.error(`[${sessionId}] FAILED: ${err.message}`)
    }
  }

  if (reports.length > 0) {
    fs.mkdirSync(RESULTS_DIR, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16)
    const outPath = path.join(RESULTS_DIR, `${stamp}-latency.json`)
    fs.writeFileSync(outPath, JSON.stringify({ date: new Date().toISOString(), topK: TOP_K, reports }, null, 2))
    console.log(`\nsaved: ${outPath}`)
  }

  await mongoose.disconnect()
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
