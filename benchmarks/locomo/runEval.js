#!/usr/bin/env node
/**
 * runEval.js — MegaMem LoCoMo evaluation harness (Phase 0)
 *
 * End-to-end eval: ingest a full LoCoMo conversation into an isolated
 * sessionId, run every answerable QA pair through retrieval, and score with
 * two methods:
 *   1. LLM judge (primary, batched Groq calls) for non-adversarial questions
 *   2. Token-overlap cross-check (free) + adversarial rejection check
 *
 * USAGE:
 *   npm run eval:locomo                          # conversation 0, full ingest
 *   npm run eval:locomo -- --conv 3              # another conversation
 *   npm run eval:locomo -- --sessions 5          # cap sessions (smoke runs)
 *   npm run eval:locomo -- --skip-ingest --session-id locomo-eval-...  # rescore only
 *   npm run eval:locomo -- --resume              # continue after crash/quota
 *
 * OUTPUT:
 *   benchmarks/results/<date>-<label>-conv<N>.json   full per-question rows
 *   benchmarks/results/<date>-<label>-conv<N>.md     summary report
 */

const path = require('path')
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') })
const fs = require('fs')
const mongoose = require('mongoose')

const { persistExtractedMemories } = require('../../src/services/memoryChatService')
const { retrieveMemory } = require('../../src/services/retrieveService')
const { completeChat } = require('../../src/services/groqService')
const { parseJsonObject } = require('../../src/utils/json')
const Memory = require('../../src/models/Memory')

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

const CONV_INDEX = parseInt(getFlag('conv') || '0', 10)
const SESSION_LIMIT = parseInt(getFlag('sessions') || '0', 10)
const TOP_K = parseInt(getFlag('topk') || '5', 10)
const BATCH_SIZE = Math.max(1, parseInt(getFlag('batch-size') || '5', 10))
const ADV_THRESHOLD = parseFloat(getFlag('adv-threshold') || '0.6')
const LABEL = getFlag('label') || 'baseline'
// Judge on a separate model so eval scoring never competes with the
// pipeline's tokens-per-day budget (Groq TPD limits are per-model).
const JUDGE_MODEL = getFlag('judge-model') || 'openai/gpt-oss-20b'
const SKIP_INGEST = hasFlag('skip-ingest')
const RESUME = hasFlag('resume')
const DATA_PATH = getFlag('data') || path.join(__dirname, 'locomo10.json')
const RESULTS_DIR = path.join(__dirname, '..', 'results')
const CHECKPOINT_PATH = path.join(__dirname, 'eval-checkpoint.json')

let SESSION_ID
if (SKIP_INGEST && getFlag('session-id')) {
  SESSION_ID = getFlag('session-id')
} else {
  SESSION_ID = `locomo-eval-conv${CONV_INDEX}-${Date.now()}`
}

const CATEGORY_NAMES = {
  1: 'single-hop',
  2: 'multi-hop',
  3: 'temporal',
  4: 'open-domain',
  5: 'adversarial'
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const percentile = (values, p) => {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  return Math.round(sorted[idx])
}

// ---------- dataset helpers ----------
const getSessionNumberFromDiaId = (diaId) => {
  const match = /^D(\d+):/.exec(diaId)
  return match ? parseInt(match[1], 10) : null
}

const buildSessionText = (sessionTurns, dateTime) => {
  const lines = sessionTurns.map((t) => `${t.speaker}: ${t.text}`)
  return `Conversation session (${dateTime}):\n${lines.join('\n')}`
}

// ---------- scoring: token overlap (free cross-check) ----------
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'is', 'was', 'were', 'are', 'be',
  'been', 'being', 'has', 'have', 'had', 'do', 'does', 'did', 'will',
  'would', 'could', 'should', 'this', 'that', 'these', 'those', 'for',
  'with', 'about', 'from', 'her', 'his', 'their', 'she', 'he', 'they',
  'them', 'not', 'some', 'any', 'each', 'every', 'week', 'before', 'after'
])

const stripPunctuation = (str) => str.replace(/[.,!?;:'"]/g, '')
const normalizeText = (val) => stripPunctuation(String(val).toLowerCase().trim())

const extractKeyTokens = (answer) => {
  const cleaned = normalizeText(answer)
  return cleaned
    .split(/\s+/)
    .filter((word) => word.length >= 4 || /^\d+$/.test(word))
    .filter((word) => !STOPWORDS.has(word))
}

const scoreTokenOverlap = (answer, memories) => {
  const normAnswer = normalizeText(answer)
  if (!normAnswer) return { correct: false, method: 'no-answer' }

  const memoryTexts = memories.map((m) => normalizeText(m.text))

  const exactMatch = memoryTexts.some((text) => text.includes(normAnswer))
  if (exactMatch) return { correct: true, method: 'exact-substring' }

  const keyTokens = extractKeyTokens(answer)
  if (keyTokens.length === 0) return { correct: false, method: 'no-key-tokens' }

  const combined = memoryTexts.join(' ')
  const matched = keyTokens.filter((token) => combined.includes(token))
  const overlapRatio = matched.length / keyTokens.length

  return {
    correct: overlapRatio >= 0.6,
    method: 'key-token-overlap',
    overlapRatio,
    keyTokens,
    matchedTokens: matched
  }
}

// ---------- scoring: batched LLM judge ----------
const buildBatchMessages = (items) => {
  const entries = items.map((item) => [
    `[${item.index}]`,
    `Question: ${item.qa.question}`,
    `Expected answer: ${item.qa.answer}`,
    `Retrieved memories:\n${item.memories.map((m) => `- ${m.text}`).join('\n')}`
  ].join('\n')).join('\n\n')

  return [
    {
      role: 'system',
      content: [
        'You are an evaluator. For each item, answer YES if the retrieved memories contain the specific information asked for by the question (dates, names, numbers, or the answer itself), even if worded differently.',
        'Answer NO only if the retrieved memories do not contain that specific information.',
        'Return only valid JSON. No markdown.'
      ].join('\n')
    },
    {
      role: 'user',
      content: [
        entries,
        '',
        'Return exactly this JSON shape:',
        '{',
        '  "verdicts": [',
        '    { "index": 0, "verdict": "YES" },',
        '    { "index": 1, "verdict": "NO" }',
        '  ]',
        '}'
      ].join('\n')
    }
  ]
}

const judgeOnce = async (items) => {
  // Models renumber verdicts from 0 regardless of the item ids they see,
  // so always present a 0-based batch and translate back afterwards.
  const localByItem = new Map(items.map((item, localIdx) => [localIdx, item]))
  const localItems = items.map((item, localIdx) => ({ ...item, index: localIdx }))

  const content = await completeChat(buildBatchMessages(localItems), {
    model: JUDGE_MODEL,
    maxTokens: Math.max(3000, localItems.length * 400),
    temperature: 0,
    timeoutMs: 60000,
    maxRetries: 2
  })

  // qwen-family models leak <think> reasoning before the JSON payload.
  const cleaned = content.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()

  const parsed = parseJsonObject(cleaned, 'Batch LLM judge')
  const verdicts = Array.isArray(parsed.verdicts) ? parsed.verdicts : []
  const byIndex = new Map()
  for (const v of verdicts) {
    // models sometimes emit indices as strings ("index": "3")
    const idx = Number(v && v.index)
    if (Number.isFinite(idx) && localByItem.has(idx)) {
      byIndex.set(localByItem.get(idx).index, String(v.verdict || '').toUpperCase())
    }
  }
  return { content, byIndex }
}

const scoreBatchLLM = async (items) => {
  // Models sometimes answer only a prefix of a large batch; chase missing
  // verdicts with follow-up calls instead of scoring them as wrong.
  const pending = [...items]
  const resolved = new Map()
  let dumpedDebug = false

  for (let round = 0; round < 3 && pending.length > 0; round++) {
    let content
    let byIndex
    try {
      ;({ content, byIndex } = await judgeOnce(pending))
    } catch (err) {
      console.error(`[judge] batch failed (${pending.length} items): ${err.message}`)
      break
    }

    const stillMissing = []
    for (const item of pending) {
      const verdict = byIndex.get(item.index)
      if (verdict && /\bYES\b/.test(verdict) && !/\bNO\b/.test(verdict)) {
        resolved.set(item.index, { correct: true, method: 'llm-judge', rawResponse: verdict })
      } else if (verdict && /\bNO\b/.test(verdict) && !/\bYES\b/.test(verdict)) {
        resolved.set(item.index, { correct: false, method: 'llm-judge', rawResponse: verdict })
      } else {
        stillMissing.push(item)
      }
    }

    if (stillMissing.length > 0 && !dumpedDebug) {
      dumpedDebug = true
      console.error(`[judge] DEBUG incomplete batch (${stillMissing.length} missing): ${content.slice(0, 400)}`)
    }

    if (stillMissing.length === pending.length && round > 0) {
      console.error('[judge] no progress on missing verdicts; giving up on them')
      break
    }
    pending.length = 0
    pending.push(...stillMissing)
    if (pending.length > 0) await sleep(500)
  }

  return items.map((item) => {
    const result = resolved.get(item.index)
    if (result) return result
    return { correct: false, method: 'llm-judge-ambiguous', rawResponse: '' }
  })
}

// Adversarial: correctly handled when retrieval returns nothing relevant.
const scoreAdversarial = (memories) => {
  if (memories.length === 0) return { correct: true, method: 'no-retrieval' }
  const topScore = memories[0]?.score ?? null
  if (topScore === null) return { correct: false, method: 'lexical-fallback-noise', topScore: null }
  return { correct: topScore < ADV_THRESHOLD, method: 'low-relevance-score', topScore }
}

// ---------- reporting ----------
const summarize = (rows) => {
  const total = rows.length
  const correct = rows.filter((r) => r.correct).length
  const nonAdv = rows.filter((r) => r.category !== 5)
  const nonAdvCorrect = nonAdv.filter((r) => r.correct).length
  const adv = rows.filter((r) => r.category === 5)
  const advCorrect = adv.filter((r) => r.correct).length
  const judged = nonAdv.filter((r) => r.method !== 'llm-judge-error')
  const judgedCorrect = judged.filter((r) => r.correct).length
  const tokenRows = rows.filter((r) => r.tokenOverlap)
  const tokenCorrect = tokenRows.filter((r) => r.tokenOverlap.correct).length

  const byCategory = {}
  for (const r of rows) {
    const name = CATEGORY_NAMES[r.category] || `category-${r.category}`
    byCategory[name] = byCategory[name] || { correct: 0, total: 0 }
    byCategory[name].total++
    if (r.correct) byCategory[name].correct++
  }

  const retrievalLatencies = rows.map((r) => r.retrievalMs).filter(Number.isFinite)

  return {
    total,
    overallAccuracy: total ? +(correct / total * 100).toFixed(1) : 0,
    nonAdversarial: { total: nonAdv.length, correct: nonAdvCorrect, accuracy: nonAdv.length ? +(nonAdvCorrect / nonAdv.length * 100).toFixed(1) : 0 },
    adversarialRejection: { total: adv.length, correct: advCorrect, accuracy: adv.length ? +(advCorrect / adv.length * 100).toFixed(1) : 0 },
    judgedAccuracy: judged.length ? +(judgedCorrect / judged.length * 100).toFixed(1) : null,
    judgeErrors: rows.filter((r) => r.method === 'llm-judge-error').length,
    tokenOverlapAccuracy: tokenRows.length ? +(tokenCorrect / tokenRows.length * 100).toFixed(1) : null,
    byCategory,
    retrievalLatencyMs: { p50: percentile(retrievalLatencies, 50), p95: percentile(retrievalLatencies, 95) }
  }
}

const renderMarkdown = (meta, summary, failures) => {
  const pct = (c, t) => t ? `${c}/${t} (+${(c / t * 100).toFixed(1)}%)`.replace('+', '') : 'n/a'
  const lines = []
  lines.push(`# LoCoMo eval — ${meta.label} — conv ${meta.convIndex} (${meta.skipIngest ? 'rescored' : 'full ingest'})`)
  lines.push('')
  lines.push(`- **Date:** ${meta.date}`)
  lines.push(`- **SessionId:** \`${meta.sessionId}\``)
  lines.push(`- **Memories stored:** ${meta.memoryCount}`)
  lines.push(`- **Sessions ingested:** ${meta.sessionsIngested}`)
  lines.push(`- **QA pairs evaluated:** ${summary.total}`)
  lines.push('')
  lines.push('## Scores')
  lines.push('')
  lines.push('| Metric | Result |')
  lines.push('|---|---|')
  lines.push(`| Overall | ${pct(summary.total ? Math.round(summary.overallAccuracy / 100 * summary.total) : 0, summary.total)} → **${summary.overallAccuracy}%** |`)
  lines.push(`| Non-adversarial | ${summary.nonAdversarial.correct}/${summary.nonAdversarial.total} → **${summary.nonAdversarial.accuracy}%** |`)
  lines.push(`| Adversarial rejection | ${summary.adversarialRejection.correct}/${summary.adversarialRejection.total} → **${summary.adversarialRejection.accuracy}%** |`)
  lines.push(`| Token-overlap cross-check | ${summary.tokenOverlapAccuracy ?? 'n/a'}% |`)
  lines.push(`| Judge errors | ${summary.judgeErrors} |`)
  lines.push(`| Retrieval latency p50/p95 | ${summary.retrievalLatencyMs.p50 ?? '?'}ms / ${summary.retrievalLatencyMs.p95 ?? '?'}ms |`)
  lines.push('')
  lines.push('## By category')
  lines.push('')
  lines.push('| Category | Correct | Accuracy |')
  lines.push('|---|---|---|')
  for (const [cat, s] of Object.entries(summary.byCategory)) {
    lines.push(`| ${cat} | ${s.correct}/${s.total} | ${(s.correct / s.total * 100).toFixed(1)}% |`)
  }
  lines.push('')
  lines.push(`## Failures (${failures.length})`)
  lines.push('')
  for (const f of failures.slice(0, 30)) {
    const label = f.category === 5 ? '[ADVERSARIAL]' : (!f.topMemory ? '[RETRIEVAL MISS]' : '[MISS]')
    lines.push(`- ${label} "${f.question}"`)
    lines.push(`  - expected: ${f.answer || '(none)'}`)
    lines.push(`  - top memory: ${f.topMemory || '(none)'}`)
    if (f.tokenOverlap && f.tokenOverlap.method !== 'exact-substring') {
      lines.push(`  - overlap: ${f.tokenOverlap.method}${f.tokenOverlap.overlapRatio != null ? ` ratio=${f.tokenOverlap.overlapRatio.toFixed(2)}` : ''}`)
    }
  }
  return lines.join('\n')
}

// ---------- main ----------
async function main () {
  console.log(`[eval] conv=${CONV_INDEX} sessions=${SESSION_LIMIT || 'ALL'} label=${LABEL} skipIngest=${SKIP_INGEST}`)
  console.log(`[eval] sessionId=${SESSION_ID}`)

  const raw = fs.readFileSync(path.resolve(DATA_PATH), 'utf-8')
  const data = JSON.parse(raw)
  if (CONV_INDEX >= data.length) {
    throw new Error(`Conversation index ${CONV_INDEX} out of range (dataset has ${data.length})`)
  }
  const conv = data[CONV_INDEX]

  const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI
  if (!mongoUri) throw new Error('No MONGO_URI or MONGODB_URI found in .env')
  await mongoose.connect(mongoUri)
  console.log('[eval] connected to MongoDB')

  // ---- ingest ----
  let sessionsIngested = 0
  let ingestKeys = []
  const INGEST_CHECKPOINT_PATH = path.join(__dirname, 'eval-ingest-checkpoint.json')

  // Session-level checkpointing so a quota trip mid-ingest is resumable.
  let alreadyIngested = new Set()
  if (RESUME && fs.existsSync(INGEST_CHECKPOINT_PATH)) {
    try {
      const icp = JSON.parse(fs.readFileSync(INGEST_CHECKPOINT_PATH, 'utf-8'))
      if (icp.sessionId === SESSION_ID && icp.convIndex === CONV_INDEX) {
        alreadyIngested = new Set(icp.ingested)
        console.log(`[eval] ingest resume: ${alreadyIngested.size} sessions already done`)
      }
    } catch { /* fresh start */ }
  }

  if (!SKIP_INGEST) {
    const sessionKeys = Object.keys(conv.conversation)
      .filter((k) => /^session_\d+$/.test(k))
      .sort((a, b) => parseInt(a.split('_')[1], 10) - parseInt(b.split('_')[1], 10))
    ingestKeys = SESSION_LIMIT > 0 ? sessionKeys.slice(0, SESSION_LIMIT) : sessionKeys

    for (const sessionKey of ingestKeys) {
      if (alreadyIngested.has(sessionKey)) {
        sessionsIngested++
        console.log(`[ingest] ${sessionKey} already done, skipping`)
        continue
      }

      const sessionNum = sessionKey.split('_')[1]
      const dateTime = conv.conversation[`session_${sessionNum}_date_time`] || 'unknown date'
      const turns = conv.conversation[sessionKey]
      const sessionText = buildSessionText(turns, dateTime)

      const startedAt = Date.now()
      console.log(`[ingest] ${sessionKey}: ${turns.length} turns, ${sessionText.length} chars...`)
      try {
        const results = await persistExtractedMemories({
          conversation: sessionText,
          sessionId: SESSION_ID
        })
        const saved = results.filter((r) => r.action === 'create' || r.action === 'update' || r.action === 'delete').length
        sessionsIngested++
        alreadyIngested.add(sessionKey)
        fs.writeFileSync(INGEST_CHECKPOINT_PATH, JSON.stringify({
          sessionId: SESSION_ID,
          convIndex: CONV_INDEX,
          ingested: [...alreadyIngested]
        }))
        console.log(`[ingest] ${sessionKey} done in ${Date.now() - startedAt}ms — ${saved} saved / ${results.length} extracted`)
      } catch (err) {
        console.error(`[ingest] ${sessionKey} FAILED: ${err.message}`)
      }
      await sleep(500)
    }
    console.log('[eval] ingestion complete; waiting 6s for vector index to settle...')
    await sleep(6000)
  }

  const memoryCount = await Memory.countDocuments({ sessionId: SESSION_ID })
  console.log(`[eval] memories in session: ${memoryCount}`)

  // ---- answerable QA pairs ----
  // Rescore mode (skip-ingest) assumes the full conversation was ingested.
  const ingestedSessionNumbers = new Set(
    (SKIP_INGEST
      ? Object.keys(conv.conversation).filter((k) => /^session_\d+$/.test(k))
      : ingestKeys
    ).map((k) => parseInt(k.split('_')[1], 10))
  )
  const answerableQa = conv.qa.filter((qa) => {
    if (!qa.evidence || qa.evidence.length === 0) return false
    return qa.evidence.every((diaId) => {
      const sessionNum = getSessionNumberFromDiaId(diaId)
      return sessionNum !== null && ingestedSessionNumbers.has(sessionNum)
    })
  })
  console.log(`[eval] ${answerableQa.length}/${conv.qa.length} QA pairs answerable`)

  // ---- resume support ----
  const completedByIndex = new Map()
  if (RESUME && fs.existsSync(CHECKPOINT_PATH)) {
    const cp = JSON.parse(fs.readFileSync(CHECKPOINT_PATH, 'utf-8'))
    if (cp.sessionId === SESSION_ID && cp.convIndex === CONV_INDEX) {
      for (const entry of cp.scored) completedByIndex.set(entry.index, entry.result)
      console.log(`[eval] resumed with ${completedByIndex.size} already-scored pairs`)
    }
  }
  const saveCheckpoint = () => {
    // Unresolved verdicts (ambiguous/errored) are never persisted, so a
    // resumed run re-judges them instead of freezing wrong scores.
    const scored = [...completedByIndex.entries()]
      .filter(([, result]) => !['llm-judge-ambiguous', 'llm-judge-error'].includes(result.method))
      .map(([index, result]) => ({ index, result }))
    fs.writeFileSync(CHECKPOINT_PATH, JSON.stringify({
      sessionId: SESSION_ID,
      convIndex: CONV_INDEX,
      scored
    }))
  }

  // ---- retrieval ----
  const RETRIEVAL_TIMEOUT_MS = 45000
  const withTimeout = (promise, ms, label) => Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms))
  ])

  const prepared = []
  for (let i = 0; i < answerableQa.length; i++) {
    if (completedByIndex.has(i)) continue
    const qa = answerableQa[i]
    const startedAt = Date.now()
    try {
      const memories = await withTimeout(
        retrieveMemory(qa.question, SESSION_ID, TOP_K),
        RETRIEVAL_TIMEOUT_MS,
        `retrieval for "${qa.question.slice(0, 40)}"`
      )
      prepared.push({ index: i, qa, memories, retrievalMs: Date.now() - startedAt })
    } catch (err) {
      console.error(`[retrieve] QA ${i} failed: ${err.message}`)
      prepared.push({ index: i, qa, memories: [], retrievalMs: Date.now() - startedAt, retrievalError: err.message })
    }
    if ((i + 1) % 25 === 0) console.log(`[retrieve] ${i + 1}/${answerableQa.length}`)
  }

  // ---- score adversarial pairs (free) ----
  const adversarial = prepared.filter((p) => p.qa.category === 5 || !p.qa.answer)
  for (const p of adversarial) {
    const scoreResult = scoreAdversarial(p.memories)
    completedByIndex.set(p.index, {
      question: p.qa.question,
      answer: p.qa.answer,
      category: p.qa.category,
      correct: scoreResult.correct,
      method: scoreResult.method,
      topMemory: p.memories[0]?.text || null,
      retrievalScore: p.memories[0]?.score ?? null,
      retrievalMs: p.retrievalMs,
      details: scoreResult,
      tokenOverlap: null
    })
  }

  // ---- score non-adversarial in batches ----
  const nonAdversarial = prepared.filter((p) => p.qa.category !== 5 && p.qa.answer)
  let batchNumber = 0
  for (let i = 0; i < nonAdversarial.length; i += BATCH_SIZE) {
    const batch = nonAdversarial.slice(i, i + BATCH_SIZE)
    batchNumber++
    console.log(`[judge] batch ${batchNumber} (${batch.length} pairs)...`)
    const llmResults = await scoreBatchLLM(batch)

    for (let j = 0; j < batch.length; j++) {
      const p = batch[j]
      completedByIndex.set(p.index, {
        question: p.qa.question,
        answer: p.qa.answer,
        category: p.qa.category,
        correct: llmResults[j].correct,
        method: llmResults[j].method,
        topMemory: p.memories[0]?.text || null,
        retrievedCount: p.memories.length,
        retrievalScore: p.memories[0]?.score ?? null,
        retrievalMs: p.retrievalMs,
        retrievalError: p.retrievalError,
        details: llmResults[j],
        tokenOverlap: scoreTokenOverlap(p.qa.answer, p.memories)
      })
    }

    saveCheckpoint()
    console.log(`[judge] checkpoint updated (${completedByIndex.size} scored)`)
    if (i + BATCH_SIZE < nonAdversarial.length) await sleep(800)
  }

  // ---- ordered results + reports ----
  const rows = []
  for (let i = 0; i < answerableQa.length; i++) {
    const result = completedByIndex.get(i)
    if (result) rows.push(result)
  }

  const summary = summarize(rows)
  const failures = rows.filter((r) => !r.correct)

  fs.mkdirSync(RESULTS_DIR, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16)
  const baseName = `${stamp}-${LABEL}-conv${CONV_INDEX}`
  const jsonPath = path.join(RESULTS_DIR, `${baseName}.json`)
  const mdPath = path.join(RESULTS_DIR, `${baseName}.md`)

  const meta = {
    date: new Date().toISOString(),
    label: LABEL,
    convIndex: CONV_INDEX,
    sessionId: SESSION_ID,
    sessionsIngested: SKIP_INGEST ? 'skipped' : sessionsIngested,
    memoryCount,
    topK: TOP_K,
    advThreshold: ADV_THRESHOLD
  }

  fs.writeFileSync(jsonPath, JSON.stringify({ meta, summary, results: rows }, null, 2))
  fs.writeFileSync(mdPath, renderMarkdown(meta, summary, failures))

  console.log('\n' + '='.repeat(60))
  console.log(`OVERALL: ${summary.overallAccuracy}%  (non-adv ${summary.nonAdversarial.accuracy}%, adv-reject ${summary.adversarialRejection.accuracy}%)`)
  console.log(`Retrieval latency p50/p95: ${summary.retrievalLatencyMs.p50}/${summary.retrievalLatencyMs.p95}ms`)
  console.log('='.repeat(60))
  console.log(`Results: ${jsonPath}`)
  console.log(`Report:  ${mdPath}`)

  saveCheckpoint()
  await mongoose.disconnect()
}

main().catch((err) => {
  console.error('[eval] failed:', err)
  process.exit(1)
})
