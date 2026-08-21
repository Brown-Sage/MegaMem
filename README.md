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

### Create the Atlas vector index

Retrieval expects a MongoDB Atlas **Vector Search** index named `vector_index` on the `memories` collection:

1. In Atlas, open your cluster → **Atlas Search & Vector Search** tab → **Create Search Index**
2. Choose **JSON Editor** (not the visual builder)
3. Select the `memories` database/collection, name the index `vector_index`, and paste:

```json
{
  "fields": [
    { "type": "vector", "path": "embedding", "numDimensions": 384, "similarity": "cosine" },
    { "type": "filter", "path": "sessionId" }
  ]
}
```

(The same definition ships in [`atlas-vector-index.json`](atlas-vector-index.json).)

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
- [ ] Multi-user support (auth + per-user memory isolation)
- [ ] Deployment packaging (Docker, hosted offering)
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
