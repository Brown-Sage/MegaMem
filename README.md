# MegaMem

MegaMem is an MCP-first memory server for AI coding assistants like Cursor and Claude Code.

The project focuses on durable, token-efficient memory:

- store important facts, preferences, decisions, and project context
- retrieve relevant memories quickly with embeddings and vector search
- keep frontend/UI work secondary to the backend memory engine
- expose memory tools through MCP as the project matures

## Current Stack

- Node.js and Express
- MongoDB with Mongoose
- Hugging Face embeddings
- Groq chat completions

## Setup

```bash
npm install
cp .env.example .env
npm start
```

## Environment

MegaMem expects these variables:

- `MONGO_URI`
- `GROQ_API_KEY`
- `HUGGINGFACE_API_KEY`

## Smoke Tests

```bash
npm run test:embed
npm run test:groq
npm run test:save
npm run test:retrieve
```

Vector retrieval expects a MongoDB vector search index named `vector_index`.
