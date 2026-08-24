# MegaMem — Deep Architecture & Accuracy Notes

_Internal working document for improving core accuracy and functionality._
_Last full code read: 2026-08-22 @ local main (post 365093a). ~2,800 LOC._

---

## 1. What MegaMem is

An MCP-first agent memory server. Two products in one:

- **MCP server** (`src/mcpServer.js`, stdio) — plugs into Cursor/Claude Code; 6 tools
- **HTTP server** (`index.js`) — `/chat`, `/mcp`, `/mcp/sse`, `/tools`

Core loop: conversations in → LLM extracts atomic facts → dedup + conflict-resolve
against existing memories → embed (384-dim MiniLM via HF) → store in MongoDB Atlas
→ semantic retrieval later, injected into prompts.

## 2. Data model

**Memory** (`src/models/Memory.js`): `userId` (owner, server-stamped), `sessionId`
(bucket: user layer `MEGAMEM_USER_ID` or workspace layer `<folder>-<sha1(cwd)>`),
`text` (≤500 chars), `type` (preference|fact|decision|task|project_context|constraint|bug|other),
`embedding[384]`, `status` (active|superseded|deleted), `dedupKey` (normalized text),
`eventAt` (resolved event date), `validUntil`, `supersededBy`. Soft delete by default.

**Profile** (`Profile.js`): compiled LLM summary per `{userId, sessionId}`, cached,
refreshed after ≥5 new memories.

**MemoryHistory**: audit trail of add/update/delete events.

Type routing (`utils/sessionId.js`): technical types (decision/task/constraint/bug/
project_context) → workspace layer; preference/fact/other → user layer; `scope`
param overrides.

## 3. The write pipeline (the heart of accuracy)

`memory_save` (single fact) or `memory_extract` → `persistExtractedMemories`:

1. **Chunking** (`utils/chunker.js`): paragraph-aware split, extraction chunks are
   tight (1800 chars, 200 overlap, max 40) so facts stay atomic.
2. **Extraction LLM** (`extractionService.js`): Groq `openai/gpt-oss-20b`,
   temperature 0, JSON out. Prompt demands discrete atomic facts w/ good/bad
   examples. Each fact gets type/importance(1-5)/confidence(0-1). Oversized (>500ch)
   memories get a type-aware re-extraction pass instead of being dropped.
3. **Rolling summary**: each chunk sees running summary + tail of previous chunk so
   pronouns resolve across chunk boundaries.
4. **Filtering**: confidence < 0.6 dropped. In-batch exact dedup (lowercased text).
5. **Race/dup guards before spending tokens**:
   - Layer 1: DB exact match on `dedupKey` (case/punct/whitespace-insensitive)
   - Layer 2: in-process ring buffer (`utils/recentWrites.js`, 10min window,
     cosine ≥ 0.92 = dup) closes Atlas's ~3s indexing blind spot
6. **Conflict detection** (`conflictService.js`): `$vectorSearch` top-8 similar
   (minScore 0.45) + recent-writes candidates → LLM judges:
   `create | update | skip | delete` (+ replacement text). Update requires
   confidence ≥ 0.75. Delete may also store the invalidating fact itself.
7. **Persist + history + recordWrite buffer entry.**

## 4. The read pipeline

`retrieveMemory(query, sessionIds, topK=5, minScore=0.6)`:

1. `$vectorSearch` per sessionId (numCandidates 50, filter sessionId+userId),
   post-filter status='active' (status isn't in the Search index), merge by best score.
2. Score threshold 0.6 (env-overridable `MEGAMEM_MIN_SCORE`). Cosine 0.5 = orthogonal;
   real matches land ~0.64+, noise ~0.57 — the margin is thin.
3. If NOTHING passes: lexical regex fallback (tokens ≥3 chars, OR-match, newest first).

Chat path (`chatWithMemory`): retrieve → buildPrompt (memories listed w/ scores,
token-guard trims to model context) → Groq answer → **fire-and-forget**
persistExtractedMemories of the Q/A pair (unawaited).

## 5. Reliability infrastructure (already good)

- Groq: semaphore (3 concurrent), retry w/ backoff, Retry-After honored,
  context-aware timeouts, reasoning-effort 'low' for gpt-oss (JSON truncation fix)
- HF embed: retry ×3, timeout 20s
- Zod validation on all MCP args + HTTP bodies; size caps (save 2k, extract 50k)
- pino structured logging to stderr (stdio-safe)
- 91 offline unit tests; test seams (`__setClient`, `__setEmbedder`)

## 6. ACCURACY WEAKNESSES — ranked by impact

### W1. `importance` and `confidence` are extracted then THROWN AWAY
`normalizeMemory()` computes both; the Memory schema has **no fields for them**.
The LLM spends tokens scoring every fact and the signal dies. This is the single
biggest free win: persist them, then use them for ranking boosts, retrieval
tie-breaks, and profile weighting.

### W2. Conflict detection recall ceiling (~paraphrase blindness)
Candidates come from one vector search at minScore 0.45. Paraphrases like
"I use Vim" vs "my editor of choice is Vim" often score 0.35–0.44 → missed →
duplicate accumulates. Also only top-8, no second-chance lexical candidates.
Mitigations: lower minScore + let the LLM judge more candidates (it's cheap vs
wrong writes), add lexical-overlap candidates to the pool, raise candidate cap.

### W3. Retrieval threshold is brittle
Global 0.6 cutoff on raw cosine. Thin margin between signal (0.64) and noise
(0.57) means queries phrased differently than the memory under-retrieve while
topical-but-wrong memories over-retrieve. No reranking step. Improvements:
- Rerank top-20 with the LLM ("does this memory answer the query?") — already
  proven pattern in your LoCoMo rescorer
- Or cross-encoder-style score fusion: vector score + recency + importance +
  type match instead of single-cosine cutoff
- Query-aware: temporal questions should boost memories with eventAt

### W4. Lexical fallback is all-or-nothing
Only fires when ZERO memories pass threshold, and it's a dumb OR-regex. Should be
a always-on second signal merged with vector results (score fusion), not a
fallback. Multi-token AND-scoring would kill most false positives.

### W5. Hard inconsistency: two delete paths
`memoryService.deleteMemory` soft-deletes (auditable, undoable).
`callMemoryDelete` (MCP tool) **hard-deletes via findOneAndDelete** — no history,
no undo, bypasses the audit design entirely. Same for `updateMemory` not running
conflict checks on the new text.

### W6. Fire-and-forget chat persistence
`chatWithMemory` never awaits the extraction pipeline. Serverless/restart kills
it mid-flight silently; errors only surface in logs. At minimum: track a
promise set + flush-on-shutdown hook; better: make it awaited-optional per caller.

### W7. Temporal resolution quirks
Year-only dates resolve to Jan 1 (`"in 2020 I moved"` → 2020-01-01) which will
mislead any future temporal ordering. Also relative expressions resolve against
session date but there's no "as-of" validity modeling beyond validUntil (which
only deletes set). Fine for now; flag before building temporal-reasoning features.

### W8. Small stuff (each ~an hour to fix)
- `/chat` HTTP requires `sessionId`; MCP tools don't — inconsistent API story
- `inferLayers`: explicit single sessionId sets BOTH layers to that id, meaning
  explicit-bucket users get their user-layer reads mixed into one bucket
- `numCandidates: 50` hardcoded; at larger scale needs tuning/topK linkage
- Post-filter on status wastes topK slots (index-level filter would fix; needs
  status added to Search index)
- `dedupeExtracted` compares raw lowercase text only — near-dup variants slip
  (dedupKey exists but isn't used here)
- Profile cache counts memories globally per bucket; deletions can make
  `newSinceCompile` go negative-ish stale logic edge cases

## 7. Suggested attack order for "better at its core"

Phase A — stop losing information you already compute:
1. Persist importance/confidence on Memory (W1) — schema + write paths
2. Fix delete-path inconsistency (W5)
3. Use dedupKey inside dedupeExtracted (W8)

Phase B — retrieval quality (most user-visible):
4. Score fusion ranking: cosine + importance boost + recency + type-awareness;
   replace hard 0.6 cut with relative-margin rule (drop score if > X below best)
5. Always-on lexical channel merged with vector channel (W4)

Phase C — write quality:
6. Conflict candidate recall: minScore 0.35–0.40 + lexical candidates + top-12 (W2)
7. Await-or-flush chat persistence (W6)

Validate each step against the LoCoMo harness (`npm run eval:locomo`) — that's
what it's for. Baseline numbers before touching anything.

## 8. File map (where to change what)

| Concern | File |
|---|---|
| Tool schemas/handlers, instructions | src/services/mcpToolService.js |
| Save/update/delete/apply decisions | src/services/memoryService.js |
| Vector + lexical retrieval | src/services/retrieveService.js |
| Conflict LLM judge + candidate pool | src/services/conflictService.js |
| Extraction prompts, normalization, budgets | src/services/extractionService.js |
| Pipeline orchestration, chunk loop | src/services/memoryChatService.js |
| Chat prompt assembly | src/services/promptService.js |
| Profile compile/cache | src/services/profileService.js |
| Groq client, retries, semaphore | src/services/groqService.js |
| HF embeddings | src/services/embedService.js |
| Two-layer routing | src/utils/sessionId.js |
| Recent-write race buffer | src/utils/recentWrites.js |
| Date resolution | src/utils/temporal.js |
| Chunking | src/utils/chunker.js |
| Validation schemas | src/validation/schemas.js |
| HTTP routes (still inline) | index.js |
