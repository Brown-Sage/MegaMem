<div align="center">

# 🧠 MegaMem

**Give your AI coding assistant a memory that never forgets.**

MegaMem is an MCP-first memory server that plugs into Claude Code, Cursor, and any MCP-compatible client — so your AI remembers your preferences, decisions, and project context across every conversation.

[![Node.js](https://img.shields.io/badge/Node.js-18%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![MCP](https://img.shields.io/badge/Protocol-MCP-blueviolet)](https://modelcontextprotocol.io)
[![MongoDB](https://img.shields.io/badge/MongoDB-Atlas%20Vector%20Search-47A248?logo=mongodb&logoColor=white)](https://www.mongodb.com/atlas)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

</div>

---

## 😤 The Problem

Every new chat with your AI assistant starts from zero.

You re-explain your stack. You re-state your preferences. You repeat the same constraints, the same conventions, the same context — again and again. Your assistant is brilliant, but it has the memory of a goldfish.

## ✨ The Solution

MegaMem sits between your AI assistant and a persistent memory store, and makes remembering **automatic**:

- 🔍 **Searches before answering** — when you reference anything that sounds like prior context, your assistant pulls the relevant memories first
- 💾 **Saves without being asked** — state a preference, make a decision, name your stack, and it's remembered. No "please remember this" required
- ⚔️ **Resolves conflicts intelligently** — when new info contradicts old info, an LLM decides whether to create, update, or ignore. Your memory stays accurate, not just big
- 🧩 **Extracts from bulk text** — paste a whole transcript, meeting notes, or a document, and MegaMem mines every durable fact out of it

No prompts to remember. No commands to learn. It just works.

## 🚀 Why MegaMem

| | |
|---|---|
| **🔌 MCP-native** | Speaks the Model Context Protocol over stdio, HTTP, and SSE. One config block and you're connected |
| **🤖 Truly automatic** | Tool descriptions teach the agent *when* to remember and recall — memory becomes a reflex, not a command |
| **🎯 Token-efficient** | Exact-match dedup and database-level checks short-circuit before any LLM call. Tokens are spent only when they add value |
| **🧬 Semantic retrieval** | 384-dim embeddings (`all-MiniLM-L6-v2`) + MongoDB Atlas `$vectorSearch` — recall by meaning, not keywords |
| **🛡️ Battle-tested pipeline** | Chunking, extraction, dedup, conflict detection, retry with exponential backoff, concurrency guards — built in |
| **💸 Cheap to run** | Hugging Face inference + Groq's Llama 3.3 70B. No OpenAI bill |

## 📊 Benchmarked on LoCoMo

We evaluate MegaMem on [LoCoMo](https://github.com/snap-research/locomo) — multi-session conversations with adversarial questions designed to trick memory systems into hallucinating — using the same answer-generation scoring as Mem0's published methodology.

<div align="center">

| Category | Score |
|---|---|
| **Overall accuracy** | **77.0%** |
| Multi-hop reasoning | 75.7% |
| Single-hop recall | 71.9% |
| Temporal reasoning | 72.7% |
| Open-domain questions | 64.3% |

</div>

**And the number nobody else reports: when a question references something that was never said, MegaMem refuses to guess instead of hallucinating an answer.** That refusal path — an LLM relevance gate between retrieval and generation — is built into every response, not bolted on.

Other things worth knowing:

- **Honest by construction** — strict containment scoring (does a stored memory actually contain the answer) and lenient LLM-judged scoring both ship in the harness, so the numbers can't be cherry-picked
- **Clean-store methodology** — this table is from a fresh single-pass ingest of one full 19-session conversation (conv0, 150 QA pairs), scored in isolation with no memory reuse across runs
- **Judge variance is disclosed** — an LLM judge re-scored on identical answers shifts category scores by a few points (open-domain varied up to ±10 between identical runs); overall accuracy stayed within ±2 across three passes (78.9% → 79.1% → 77.0% as ambiguous verdicts resolved). 135/150 judged; 15 questions were structurally unresolvable by the lenient judge and are excluded, not counted as misses or hits
- **Self-hosted, free-tier models** — this benchmark ran entirely on free API tiers (Mistral + Hugging Face), not a stack of paid frontier-model calls
- **Reproducible** — `npm run eval:locomo` with per-question verdicts, retrieval dumps, and checkpointed resumption all in the repo

> Full methodology, per-category breakdowns, and failure analysis live in `benchmarks/`. Full-dataset runs (all 10 conversations) are in progress.

## 🧰 The Five Tools

MegaMem exposes five tools over MCP. Your assistant learns to use them proactively — you never call them yourself.

| Tool | What it does |
|---|---|
| `memory_search` | Semantic search over stored memories, with relevance scores |
| `memory_save` | Saves a single fact; runs conflict detection before writing |
| `memory_extract` | Runs the full pipeline on long text — chunks, extracts, dedups, resolves conflicts |
| `memory_list` | Browses memories with cursor-based pagination |
| `memory_delete` | Removes a memory by ID |

## ⚙️ How It Works

```
You chat with your AI assistant
        │
        ▼
┌──────────────────┐   preference / decision / fact detected
│   memory_save    │ ──────────────────────────────►
└──────────────────┘
        │
        ▼
 Exact-match check ── duplicate? ──► skip (zero tokens spent)
        │ no
        ▼
 Hugging Face embeds the text (384-dim vector)
        │
        ▼
 MongoDB Atlas $vectorSearch finds similar memories
        │
        ▼
 Groq (Llama 3.3 70B) judges: CREATE / UPDATE / IGNORE
        │
        ▼
 Memory persisted — available in every future session
```

Retrieval runs the same path in reverse: your question is embedded, the most relevant memories surface, and your assistant answers with full context of who you are and what you've decided.

## 🏁 Quickstart

```bash
git clone https://github.com/Brown-Sage/MegaMem.git
cd megamem
npm install
cp .env.example .env   # fill in your keys
```

**Prerequisites**

- Node.js 18+
- A free [MongoDB Atlas](https://www.mongodb.com/atlas) cluster (M0 free tier works)
- Free API keys: [Groq](https://console.groq.com/keys) (LLM) and [Hugging Face](https://huggingface.co/settings/tokens) (embeddings)

**Environment variables**

| Variable | Purpose |
|---|---|
| `MONGO_URI` | MongoDB Atlas connection string |
| `GROQ_API_KEY` | Groq API key (chat completions) |
| `HUGGINGFACE_API_KEY` | Hugging Face key (embeddings) |
| `MEGAMEM_USER_ID` | Optional. Owner id for your memories (defaults to `default-user`) |
| `MEGAMEM_WORKSPACE_ID` | Optional. Override the workspace layer id (defaults to `<folder>-<hash of cwd>`) |
| `GROQ_MODEL` | Optional. Override the LLM (default `openai/gpt-oss-20b`) |

### Verify everything works

```bash
npm run doctor
```

Checks Node version, your `.env`, the MongoDB/Atlas connection, that the `vector_index` search index has the right fields, and that the Hugging Face + Groq endpoints respond with your keys. Fix any ✖ items it prints before continuing.

### Create the Atlas vector index

Retrieval expects a MongoDB Atlas **Vector Search** index named `vector_index` on the `memories` collection:

1. In Atlas, open your cluster → **Atlas Search & Vector Search** tab → **Create Search Index**
2. Choose **JSON Editor** (not the visual builder)
3. Select the `memories` database/collection, name the index `vector_index`, and paste:

```json
{
  "fields": [
    { "type": "vector", "path": "embedding", "numDimensions": 384, "similarity": "cosine" },
    { "type": "filter", "path": "sessionId" },
    { "type": "filter", "path": "userId" }
  ]
}
```

(The same definition ships in [`atlas-vector-index.json`](atlas-vector-index.json).)

> **Already running an older MegaMem?** If your index was created before `userId` existed, edit it: **Atlas Search & Vector Search** → `vector_index` → **Edit Index Definition** → add `{ "type": "filter", "path": "userId" }` to `fields` → save. Atlas rebuilds the index automatically (a few minutes on M0); searches keep working during the rebuild. Until this field is added, `$vectorSearch` ignores the owner filter — regular queries are unaffected. Verify with `npm run doctor`.

> ⚠️ **Security note:** the HTTP and SSE transports (`POST /chat`, `/mcp`, `/mcp/sse`) are unauthenticated — run them on localhost or a trusted network only. The MCP stdio transport (Cursor / Claude Code) is the recommended integration path; it runs entirely on your machine.
>
> 🔒 **Your data stays yours:** memories live in *your* Atlas cluster, and LLM/embedding calls go to Groq and Hugging Face with your own keys. No third-party memory service sees anything.

## 🔌 Connect Your Assistant

**Cursor** — merge MegaMem into your user config (`~/.cursor/mcp.json`):

```bash
cp .env.example .env   # fill in your keys
npm run install:mcp
```

The script writes only the `megamem` server (other MCP servers are left alone). It uses the absolute path to `src/mcpServer.js` and reads secrets from the repo `.env` — they are not copied into `mcp.json`. Use `npm run install:mcp -- --dry-run` to preview, or `npm run install:mcp -- --remove` to drop the MegaMem entry.

```json
{
  "mcpServers": {
    "megamem": {
      "command": "node",
      "args": ["/absolute/path/to/MegaMem/src/mcpServer.js"]
    }
  }
}
```

**Claude Code**:

```bash
claude mcp add megamem \
  -e MONGO_URI=your-mongo-uri \
  -e GROQ_API_KEY=your-groq-key \
  -e HUGGINGFACE_API_KEY=your-hf-key \
  -- node /absolute/path/to/MegaMem/src/mcpServer.js
```

That's it. From the next message onward, your assistant searches and saves memory on its own.

## 🌐 HTTP API

Prefer HTTP? Run the Express server:

```bash
npm start
```

| Endpoint | Description |
|---|---|
| `POST /chat` | Chat with memory-augmented context |
| `POST /mcp` | MCP over HTTP (JSON-RPC) |
| `GET /mcp/sse` | MCP over Server-Sent Events |
| `GET /tools` | List available memory tools |

## 🐳 Docker

Run the HTTP server in a container (MongoDB Atlas stays external — `$vectorSearch` requires it):

```bash
cp .env.example .env   # fill in MONGO_URI + keys
docker compose up --build -d
curl localhost:3000/tools   # smoke check
```

For the MCP stdio transport under Docker (less common — stdio is usually run on the host):

```bash
docker build -t megamem .
docker run --rm --env-file .env -i megamem node src/mcpServer.js
```

## 🔧 Troubleshooting

- **`npm run doctor` says `vector_index lacks "userId"`** — edit your index definition per the note above; Atlas rebuilds it automatically.
- **Semantic search returns nothing but exact search works** — Atlas Search indexes take a few minutes to build after creation, and newly written memories are searchable only after indexing (~3s). The recent-writes buffer hides this during rapid saves.
- **Groq 404 / model errors** — MegaMem defaults to `openai/gpt-oss-20b`. Set `GROQ_MODEL` to override if you prefer another model available on your Groq account.
- **Hugging Face 503** — the embedding model is cold/warming; retry in a minute.
- **Memories from another project leak into this one** — they won't: workspace memories are keyed by `<folder>-<hash(cwd)>`, and everything is scoped by `MEGAMEM_USER_ID`. Check both env vars if you *want* sharing between two folders.

## 🏗️ Project Structure

```
MegaMem/
├── index.js                    # Express server (HTTP + SSE transports)
├── src/
│   ├── mcpServer.js            # MCP stdio server (for Claude Code / Cursor)
│   ├── config/db.js            # MongoDB connection
│   ├── models/Memory.js        # Memory schema (text + 384-dim embedding)
│   ├── services/
│   │   ├── mcpToolService.js   # MCP tool definitions + JSON-RPC handlers
│   │   ├── memoryService.js    # Save / update / apply decisions
│   │   ├── retrieveService.js  # Vector search retrieval
│   │   ├── conflictService.js  # LLM conflict detection (create/update/ignore)
│   │   ├── extractionService.js# Bulk fact extraction from long text
│   │   ├── memoryChatService.js# Memory-augmented chat + persistence
│   │   ├── embedService.js     # Hugging Face embeddings
│   │   ├── groqService.js      # Groq client (retry, timeouts, semaphore)
│   │   └── promptService.js    # Prompt templates
│   └── utils/
│       ├── chunker.js          # Text chunking (lossless bounded output)
│       ├── temporal.js         # Deterministic date resolution
│       ├── dedupKey.js         # Normalized duplicate detection keys
│       ├── recentWrites.js     # In-memory write buffer (race protection)
│       ├── tokenGuard.js       # Input size guards
│       ├── json.js             # JSON helpers
│       └── log.js              # Structured logging (pino, stderr)
├── tests/unit/                 # Offline unit tests (no network needed)
└── benchmarks/                 # LoCoMo eval harness (contributor-facing)
```

## 🧪 Tests

**Unit tests** run fully offline (LLM and embedding clients are mocked):

```bash
npm test        # 88 tests — conflict logic, chunker, temporal, validation, routing…
npm run lint    # eslint
```

Live smoke tests for every pipeline stage also exist under `tests/` (`npm run test:save`, `test:retrieve`, `test:mcp`, …) — these call real APIs and need keys in `.env`.

The LoCoMo evaluation harness (`benchmarks/locomo/runEval.js`, `npm run eval:locomo`) is contributor-facing; it requires downloading the [LoCoMo dataset](https://github.com/snap-research/locomo) separately.

## 🗺️ Roadmap

- [x] Automatic memory pipeline (extract → dedup → conflict-detect → persist)
- [x] MCP server with stdio, HTTP, and SSE transports
- [x] Self-directing tool descriptions (agents use memory proactively)
- [x] Two-layer memory (user + workspace) with per-owner scoping (`MEGAMEM_USER_ID`)
- [x] One-command setup doctor (`npm run doctor`) + Docker packaging
- [ ] Fully-local mode without Atlas ($vectorSearch currently requires MongoDB Atlas)
- [ ] Memory dashboard / UI

## 🧱 Built With

- **Node.js + Express** — server & transports
- **MongoDB Atlas** — storage + `$vectorSearch`
- **Hugging Face** — `all-MiniLM-L6-v2` embeddings (384-dim)
- **Groq** — Llama 3.3 70B for extraction, conflict resolution, and chat

---

<div align="center">

**Stop repeating yourself. Let your AI remember.**

</div>
