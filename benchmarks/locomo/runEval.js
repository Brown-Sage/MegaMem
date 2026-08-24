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
// qwen3.6-27b: separate TPD bucket from the pipeline; its <think> reasoning
// is stripped below. NOTE: llama chat models were retired from Groq — don't
// fall back to llama-* ids.
//
// MEGAMEM_JUDGE_PROVIDER routes the judge to a different OpenAI-compatible
// provider (see groqService.js PROVIDERS). Set it when the pipeline runs on
// the same provider so scoring doesn't share its quota bucket. The provider
// is applied by temporarily switching the env before the first judge call —
// groqService resolves the client lazily, and completeChat's `model` option
// overrides DEFAULT_MODEL, so no call-site changes are needed.
const JUDGE_PROVIDER = (getFlag('judge-provider') || process.env.MEGAMEM_JUDGE_PROVIDER || '').toLowerCase() || null
const JUDGE_MODEL_DEFAULTS = {
  groq: 'qwen/qwen3.6-27b',
  mistral: 'mistral-large-latest',
  cerebras: 'llama3.1-8b'
}
const JUDGE_MODEL = getFlag('judge-model') || (JUDGE_PROVIDER && JUDGE_MODEL_DEFAULTS[JUDGE_PROVIDER]) || 'qwen/qwen3.6-27b'
const SKIP_INGEST = hasFlag('skip-ingest')
const RESUME = hasFlag('resume')
const DATA_PATH = getFlag('data') || path.join(__dirname, 'locomo10.json')
const RESULTS_DIR = path.join(__dirname, '..', 'results')
// Per-conversation checkpoint files — parallel conversations must not clobber
// each other's progress, and resume must pick the right scope.
const CHECKPOINT_PATH = (convIdx) => path.join(__dirname, `eval-checkpoint-conv${convIdx}.json`)
const INGEST_CHECKPOINT_PATH = (convIdx) => path.join(__dirname, `eval-ingest-checkpoint-conv${convIdx}.json`)
// Official full-dataset run: all 10 conversations, all sessions, one result set.
// Ingest is sequential per conversation; QA scoring runs per conversation right
// after its ingest so checkpoint/resume stays conversation-scoped.
const ALL_CONVS = hasFlag('all-convs')
// Parallelism: conversations are independent (separate sessionIds), sessions
// within a conversation are chunk-independent, retrieval is read-only, and
// judge batches write disjoint checkpoint entries. Providers rate-limit per
// account, so the global LLM semaphore in groqService.js is the real throttle.
const CONV_CONCURRENCY = Math.max(1, parseInt(getFlag('convs') || '4', 10))
const SESSION_CONCURRENCY = Math.max(1, parseInt(getFlag('session-conc') || '2', 10))
const RETRIEVAL_CONCURRENCY = Math.max(1, parseInt(getFlag('retrieve-conc') || '6', 10))
const JUDGE_CONCURRENCY = Math.max(1, parseInt(getFlag('judge-conc') || '3', 10))

// Run a task producer with a bounded worker pool; preserves result order.
const mapPool = async (items, limit, worker) => {
  const results = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const idx = next++
      if (idx >= items.length) return
      results[idx] = await worker(items[idx], idx)
    }
  })
  await Promise.all(workers)
  return results
}

// Single-conversation runs can pin an explicit sessionId (--skip-ingest
// --session-id ...). All-convs runs derive deterministic per-conversation ids.
const SESSION_ID = (SKIP_INGEST && getFlag('session-id'))
  ? getFlag('session-id')
  : `locomo-eval-conv${CONV_INDEX}-${Date.now()}`

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

  // Route the judge to its own provider bucket when one is set. The pipeline
  // provider env is saved/restored so ingest calls are untouched; groqService
  // caches one client per process, so the first judge call under the switched
  // env binds the judge client and later pipeline calls restore their own env
  // BEFORE any client is constructed for them (lazy resolution).
  let content
  if (JUDGE_PROVIDER) {
    const pipelineProvider = process.env.MEGAMEM_LLM_PROVIDER
    process.env.MEGAMEM_LLM_PROVIDER = JUDGE_PROVIDER
    try {
      content = await completeChat(buildBatchMessages(localItems), {
        model: JUDGE_MODEL,
        maxTokens: Math.max(3000, localItems.length * 400),
        temperature: 0,
        timeoutMs: 60000,
        maxRetries: 2
      })
    } finally {
      if (pipelineProvider === undefined) delete process.env.MEGAMEM_LLM_PROVIDER
      else process.env.MEGAMEM_LLM_PROVIDER = pipelineProvider
    }
  } else {
    content = await completeChat(buildBatchMessages(localItems), {
      model: JUDGE_MODEL,
      maxTokens: Math.max(3000, localItems.length * 400),
      temperature: 0,
      timeoutMs: 60000,
      maxRetries: 2
    })
  }

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
      // Case-insensitive: providers differ in verdict casing (qwen emits
      // uppercase YES/NO; mistral-small writes "Yes"/"No"). Word boundaries
      // keep \bNO\b from matching inside "NOT"/"notable".
      if (verdict && /\bYES\b/i.test(verdict) && !/\bNO\b/i.test(verdict)) {
        resolved.set(item.index, { correct: true, method: 'llm-judge', rawResponse: verdict })
      } else if (verdict && /\bNO\b/i.test(verdict) && !/\bYES\b/i.test(verdict)) {
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
  lines.push(`# LoCoMo eval — ${meta.label} — conv ${meta.convIndex}${meta.skipIngest ? ' (rescored)' : ''}`)
  lines.push('')
  lines.push(`- **Date:** ${meta.date}`)
  if (meta.sessionId) lines.push(`- **SessionId:** \`${meta.sessionId}\``)
  if (meta.memoryCount != null) lines.push(`- **Memories stored:** ${meta.memoryCount}`)
  if (meta.sessionsIngested != null) lines.push(`- **Sessions ingested:** ${meta.sessionsIngested}`)
  if (meta.conversations != null) lines.push(`- **Conversations:** ${meta.conversations}`)
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
  console.log(`[eval] conv=${ALL_CONVS ? 'ALL' : CONV_INDEX} sessions=${SESSION_LIMIT || 'ALL'} label=${LABEL} skipIngest=${SKIP_INGEST}`)
  console.log(`[eval] parallelism: convs=${CONV_CONCURRENCY} sessions=${SESSION_CONCURRENCY} retrieval=${RETRIEVAL_CONCURRENCY} judge=${JUDGE_CONCURRENCY}`)

  const raw = fs.readFileSync(path.resolve(DATA_PATH), 'utf-8')
  const data = JSON.parse(raw)
  if (!ALL_CONVS && CONV_INDEX >= data.length) {
    throw new Error(`Conversation index ${CONV_INDEX} out of range (dataset has ${data.length})`)
  }

  const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI
  if (!mongoUri) throw new Error('No MONGO_URI or MONGODB_URI found in .env')
  await mongoose.connect(mongoUri)
  console.log('[eval] connected to MongoDB')

  const convIndexes = ALL_CONVS
    ? data.map((_, i) => i)
    : [CONV_INDEX]

  // Deterministic per-conversation sessionIds — a resumed run must land on the
  // same store without consulting state that a crash could have lost.
  const sessionIdFor = (convIdx) => `locomo-eval-conv${convIdx}-official`

  // ---- phase 1: ingest all conversations with a bounded pool ----
  if (!SKIP_INGEST) {
    await mapPool(convIndexes, CONV_CONCURRENCY, async (convIdx) => {
      await ingestConversation(data[convIdx], convIdx, sessionIdFor(convIdx))
    })
    console.log('[eval] all ingestion complete; waiting 8s for vector index to settle...')
    await sleep(8000)
  }

  // ---- phase 2: score every conversation in parallel ----
  const allConvRows = await mapPool(convIndexes, Math.max(CONV_CONCURRENCY, 2), async (convIdx) => ({
    convIndex: convIdx,
    rows: await scoreConversation(data[convIdx], convIdx, sessionIdFor(convIdx))
  }))

  // ---- combined report ----
  if (allConvRows.length > 1) {
    const combined = allConvRows.flatMap((c) => c.rows)
    const summary = summarize(combined)
    fs.mkdirSync(RESULTS_DIR, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16)
    const baseName = `${stamp}-${LABEL}-ALL`
    const jsonPath = path.join(RESULTS_DIR, `${baseName}.json`)
    const mdPath = path.join(RESULTS_DIR, `${baseName}.md`)
    const meta = {
      date: new Date().toISOString(),
      label: LABEL,
      convIndex: 'all',
      conversations: allConvRows.length,
      totalQa: combined.length,
      topK: TOP_K,
      advThreshold: ADV_THRESHOLD
    }
    fs.writeFileSync(jsonPath, JSON.stringify({
      meta,
      summary,
      perConversation: allConvRows.map((c) => ({
        convIndex: c.convIndex,
        summary: summarize(c.rows),
        results: c.rows
      }))
    }, null, 2))
    fs.writeFileSync(mdPath, renderMarkdown(meta, summary, combined.filter((r) => !r.correct)))
    console.log('\n' + '='.repeat(60))
    console.log(`ALL CONVERSATIONS: OVERALL ${summary.overallAccuracy}%  (non-adv ${summary.nonAdversarial.accuracy}%, adv-reject ${summary.adversarialRejection.accuracy}%)`)
    for (const c of allConvRows) {
      const s = summarize(c.rows)
      console.log(`  conv ${c.convIndex}: ${s.overallAccuracy}% overall / ${s.nonAdversarial.accuracy}% non-adv / ${s.adversarialRejection.accuracy}% adv-reject (${s.total} QA)`)
    }
    console.log('='.repeat(60))
    console.log(`Results: ${jsonPath}`)
    console.log(`Report:  ${mdPath}`)
  }

  await mongoose.disconnect()
}

// Ingests every session of one conversation into its own sessionId.
async function ingestConversation (conv, convIdx, sessionId) {
  const cpPath = INGEST_CHECKPOINT_PATH(convIdx)
  let alreadyIngested = new Set()
  if (RESUME && fs.existsSync(cpPath)) {
    try {
      const icp = JSON.parse(fs.readFileSync(cpPath, 'utf-8'))
      if (icp.sessionId === sessionId) alreadyIngested = new Set(icp.ingested)
    } catch { /* fresh start */ }
  }

  const sessionKeys = Object.keys(conv.conversation)
    .filter((k) => /^session_\d+$/.test(k))
    .sort((a, b) => parseInt(a.split('_')[1], 10) - parseInt(b.split('_')[1], 10))
  const ingestKeys = SESSION_LIMIT > 0 ? sessionKeys.slice(0, SESSION_LIMIT) : sessionKeys

  console.log(`[conv ${convIdx}] ingesting ${ingestKeys.length} sessions -> ${sessionId}`)

  let done = 0
  await mapPool(ingestKeys, SESSION_CONCURRENCY, async (sessionKey) => {
    if (alreadyIngested.has(sessionKey)) {
      done++
      return
    }

    const sessionNum = sessionKey.split('_')[1]
    const dateTime = conv.conversation[`session_${sessionNum}_date_time`] || 'unknown date'
    const turns = conv.conversation[sessionKey]
    const sessionText = buildSessionText(turns, dateTime)

    const startedAt = Date.now()
    try {
      const results = await persistExtractedMemories({
        conversation: sessionText,
        sessionId
      })
      const saved = results.filter((r) => r.action === 'create' || r.action === 'update' || r.action === 'delete').length
      alreadyIngested.add(sessionKey)
      done++
      fs.writeFileSync(cpPath, JSON.stringify({ sessionId, convIndex: convIdx, ingested: [...alreadyIngested] }))
      console.log(`[conv ${convIdx}] ${sessionKey} done in ${Date.now() - startedAt}ms — ${saved} saved / ${results.length} extracted (${done}/${ingestKeys.length})`)
    } catch (err) {
      console.error(`[conv ${convIdx}] ${sessionKey} FAILED: ${err.message}`)
    }
  })

  console.log(`[conv ${convIdx}] ingestion complete (${alreadyIngested.size}/${ingestKeys.length} sessions)`)
}

// Scores all answerable QA pairs for one conversation against its store.
async function scoreConversation (conv, convIdx, sessionId) {

  const memoryCount = await Memory.countDocuments({ sessionId })
  console.log(`[conv ${convIdx}] memories in session: ${memoryCount}`)

  // ---- answerable QA pairs ----
  // Rescore mode (skip-ingest) assumes the full conversation was ingested.
  const ingestedSessionNumbers = new Set(
    Object.keys(conv.conversation)
      .filter((k) => /^session_\d+$/.test(k))
      .map((k) => parseInt(k.split('_')[1], 10))
  )
  const answerableQa = conv.qa.filter((qa) => {
    if (!qa.evidence || qa.evidence.length === 0) return false
    return qa.evidence.every((diaId) => {
      const sessionNum = getSessionNumberFromDiaId(diaId)
      return sessionNum !== null && ingestedSessionNumbers.has(sessionNum)
    })
  })
  console.log(`[conv ${convIdx}] ${answerableQa.length}/${conv.qa.length} QA pairs answerable`)

  // ---- resume support ----
  const cpPath = CHECKPOINT_PATH(convIdx)
  const completedByIndex = new Map()
  if (RESUME && fs.existsSync(cpPath)) {
    const cp = JSON.parse(fs.readFileSync(cpPath, 'utf-8'))
    if (cp.sessionId === sessionId) {
      for (const entry of cp.scored) completedByIndex.set(entry.index, entry.result)
      console.log(`[conv ${convIdx}] resumed with ${completedByIndex.size} already-scored pairs`)
    }
  }
  const saveCheckpoint = () => {
    // Unresolved verdicts (ambiguous/errored) are never persisted, so a
    // resumed run re-judges them instead of freezing wrong scores.
    const scored = [...completedByIndex.entries()]
      .filter(([, result]) => !['llm-judge-ambiguous', 'llm-judge-error'].includes(result.method))
      .map(([index, result]) => ({ index, result }))
    fs.writeFileSync(cpPath, JSON.stringify({
      sessionId,
      convIndex: convIdx,
      scored
    }))
  }

  // ---- retrieval (parallel; read-only so workers can overlap freely) ----
  const RETRIEVAL_TIMEOUT_MS = 45000
  const withTimeout = (promise, ms, label) => Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms))
  ])

  const pendingIndexes = []
  for (let i = 0; i < answerableQa.length; i++) {
    if (!completedByIndex.has(i)) pendingIndexes.push(i)
  }

  let retrievedCount = 0
  const prepared = await mapPool(pendingIndexes, RETRIEVAL_CONCURRENCY, async (i) => {
    const qa = answerableQa[i]
    const startedAt = Date.now()
    try {
      const memories = await withTimeout(
        retrieveMemory(qa.question, sessionId, TOP_K),
        RETRIEVAL_TIMEOUT_MS,
        `retrieval for "${qa.question.slice(0, 40)}"`
      )
      retrievedCount++
      if (retrievedCount % 25 === 0) console.log(`[conv ${convIdx}] retrieved ${retrievedCount}/${pendingIndexes.length}`)
      return { index: i, qa, memories, retrievalMs: Date.now() - startedAt }
    } catch (err) {
      console.error(`[conv ${convIdx}] QA ${i} retrieval failed: ${err.message}`)
      return { index: i, qa, memories: [], retrievalMs: Date.now() - startedAt, retrievalError: err.message }
    }
  })

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

  // ---- score non-adversarial in parallel batches ----
  const nonAdversarial = prepared.filter((p) => p.qa.category !== 5 && p.qa.answer)
  const batches = []
  for (let i = 0; i < nonAdversarial.length; i += BATCH_SIZE) {
    batches.push(nonAdversarial.slice(i, i + BATCH_SIZE))
  }
  console.log(`[conv ${convIdx}] judging ${batches.length} batches (${nonAdversarial.length} pairs, ${JUDGE_CONCURRENCY} at a time)`)

  let judgedBatches = 0
  await mapPool(batches, JUDGE_CONCURRENCY, async (batch) => {
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
    judgedBatches++
    saveCheckpoint()
    console.log(`[conv ${convIdx}] batch ${judgedBatches}/${batches.length} done (${completedByIndex.size} scored)`)
  })

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
  const baseName = `${stamp}-${LABEL}-conv${convIdx}`
  const jsonPath = path.join(RESULTS_DIR, `${baseName}.json`)
  const mdPath = path.join(RESULTS_DIR, `${baseName}.md`)

  const meta = {
    date: new Date().toISOString(),
    label: LABEL,
    convIndex: convIdx,
    sessionId,
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
  return rows
}

main().catch((err) => {
  console.error('[eval] failed:', err)
  process.exit(1)
})
