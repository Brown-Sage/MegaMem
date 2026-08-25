// R4a: lightweight lexical topic index of stored memories, written by the
// session-start hook after its main fetches succeed. Consumers:
//   - future postToolUse/preCompact injectors (R4b/R4c), IF the injection
//     spike ever passes — they need sub-100ms pure-JS matching against this
//     file, no DB, no embed, no LLM.
//   - diagnostics: what does the agent's recall surface actually look like?
//
// Best-effort by design: any failure logs and skips. A missing or stale index
// must never break session start. Tokens are pre-normalized so consumers pay
// zero preprocessing cost.

const fs = require('fs')
const path = require('path')

const MAX_ENTRIES_PER_BUCKET = 300
const MIN_TOKEN_LEN = 3

// Stopwords too common in memory texts to discriminate topics. Kept tiny on
// purpose — matching is OR-ish, so extra words here cost little recall.
const STOPWORDS = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'has', 'have', 'was', 'are', 'his', 'her', 'their', 'its', 'not', 'but', 'all', 'can', 'will', 'who', 'why', 'how', 'what', 'when', 'where', 'which', 'into', 'than', 'then', 'them', 'they', 'there'])

const tokenize = (text) => String(text)
  .toLowerCase()
  .normalize('NFKD')
  .replace(/[^\p{L}\p{N}\s]/gu, ' ')
  .split(/\s+/)
  .filter((t) => t.length >= MIN_TOKEN_LEN && !STOPWORDS.has(t))

// Newest first (createdAt desc), capped. Shape kept minimal: id for potential
// follow-up reads, text as fallback display, tokens pre-split for matchers.
const buildTopicIndex = async ({ Memory, sessionIds }) => {
  const buckets = {}
  for (const bucket of sessionIds) {
    const rows = await Memory.find({
      sessionId: bucket,
      status: 'active'
    })
      .sort({ createdAt: -1 })
      .limit(MAX_ENTRIES_PER_BUCKET)
      .select('_id text')
      .lean()

    buckets[bucket] = rows.map((r) => ({
      id: r._id.toString(),
      text: r.text,
      tokens: tokenize(r.text)
    })).filter((e) => e.tokens.length > 0)
  }
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    buckets
  }
}

const writeTopicIndex = async ({ stateDir, index }) => {
  fs.mkdirSync(stateDir, { recursive: true })
  const tmp = path.join(stateDir, 'topic-index.json.tmp')
  const target = path.join(stateDir, 'topic-index.json')
  // Atomic write: readers (hook processes) never see a half-file.
  fs.writeFileSync(tmp, JSON.stringify(index))
  fs.renameSync(tmp, target)
}

module.exports = { buildTopicIndex, writeTopicIndex, tokenize, MAX_ENTRIES_PER_BUCKET }
