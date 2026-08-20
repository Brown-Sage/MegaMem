const path = require('path')
const crypto = require('crypto')
const mongoose = require('mongoose')
const { retrieveMemory } = require('./retrieveService')
const { saveMemory, updateMemory, applyMemoryDecision } = require('./memoryService')
const { detectMemoryConflict } = require('./conflictService')
const { persistExtractedMemories } = require('./memoryChatService')
const Memory = require('../models/Memory')

const DEFAULT_SESSION_ID = 'aryan-main'

const workspaceSessionId = () => {
  const cwd = process.cwd()
  const base = path.basename(cwd)
  const hash = crypto.createHash('sha1').update(cwd).digest('hex').slice(0, 8)
  return `${base}-${hash}`
}

const resolveSessionId = (explicit) => {
  if (explicit) return explicit
  if (process.env.MEGAMEM_SESSION_ID) return process.env.MEGAMEM_SESSION_ID
  return workspaceSessionId() || DEFAULT_SESSION_ID
}

const MEMORY_SAVE_MAX_CHARS = 2000
const MEMORY_EXTRACT_MAX_CHARS = 50000

const SERVER_INSTRUCTIONS = `You have persistent memory across conversations via MegaMem's memory tools. Use it proactively, without waiting for the user to ask:
- BEFORE answering: call memory_search whenever the user references a preference, past decision, personal detail, project context, or anything that sounds like prior conversation.
- IMMEDIATELY: call memory_save whenever the user states a preference, makes a decision, shares a personal fact, mentions a constraint, or names tools/stack they use. Do not ask for permission first — just save.
- Use memory_extract instead of memory_save for bulk extraction from long text (transcripts, documents, meeting notes).
- Use memory_list to review what is stored and memory_delete to clean up outdated memories.
All tools default to the correct session automatically — no sessionId needed.`

const MEMORY_TOOLS = [
  {
    name: 'memory_search',
    description: 'Search stored memories using semantic similarity. Returns the top matching memories with relevance scores.\n\nWHEN TO USE: Search memory when the user references a preference, past decision, personal detail, or something that sounds like it depends on prior conversation. Do not search for purely technical questions, math calculations, or one-off requests unrelated to personal context.\n\nsessionId: optional, defaults to the current workspace automatically.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to search for' },
        sessionId: { type: 'string', description: 'Session identifier (optional, defaults to the current workspace)' },
        topK: { type: 'number', description: 'How many memories to return (default 5)' }
      },
      required: ['query']
    }
  },
  {
    name: 'memory_save',
    description: 'Save a single concise fact to memory. Runs conflict detection: if a similar memory exists, returns a decision (create/update/ignore). Rejects inputs longer than 2000 characters — use memory_extract for long text.\n\nWHEN TO USE: Proactively save memories whenever the user states a preference, makes a decision, shares a personal fact, mentions a constraint, names a tool or stack they use, or provides any information that would be useful to remember in future conversations. Save automatically without asking for permission first — but the tool call itself should be visible to the user as normal (don\'t suppress or hide the invocation).\n\nsessionId: optional, defaults to the current workspace automatically.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The memory text to save (must be a single concise fact, max 2000 chars)' },
        sessionId: { type: 'string', description: 'Session identifier (optional, defaults to the current workspace)' }
      },
      required: ['text']
    }
  },
  {
    name: 'memory_extract',
    description: 'Run the full auto-memory pipeline on a long conversation or document. Chunks the input, runs extraction LLM on each chunk, deduplicates facts, runs conflict detection on each fact, and persists the results. Returns actions taken.\n\nWHEN TO USE: Use this INSTEAD of memory_save when you have a long block of text (a conversation transcript, meeting notes, a document) from which multiple facts should be extracted. memory_save is for a single fact; memory_extract is for bulk extraction from rich text.\n\nsessionId: optional, defaults to the current workspace automatically.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The conversation or document text to extract memories from' },
        sessionId: { type: 'string', description: 'Session identifier (optional, defaults to the current workspace)' }
      },
      required: ['text']
    }
  },
  {
    name: 'memory_list',
    description: 'List memories with cursor-based pagination, ordered by most recently created.\n\nWHEN TO USE: Use when you need to browse all stored memories, review what\'s been saved, or help the user manage their memory store.\n\nsessionId: optional, defaults to the current workspace automatically.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Session identifier (optional, defaults to the current workspace)' },
        limit: { type: 'number', description: 'Maximum number of memories to return (default 20)' },
        cursor: { type: 'string', description: 'The memoryId from the last memory in the previous page. Omit for the first page.' }
      },
      required: []
    }
  },
  {
    name: 'memory_delete',
    description: 'Delete a single memory by its ID. Returns confirmation.\n\nWHEN TO USE: Use when the user asks to remove a specific memory, or when you identify an outdated/incorrect memory that should be cleaned up.',
    inputSchema: {
      type: 'object',
      properties: {
        memoryId: { type: 'string', description: 'The Mongo _id of the memory to delete' }
      },
      required: ['memoryId']
    }
  }
]

const jsonRpcResult = (id, result) => ({ jsonrpc: '2.0', id, result })
const jsonRpcError = (id, code, message, data) => ({
  jsonrpc: '2.0',
  id,
  error: { code, message, ...(data !== undefined ? { data } : {}) }
})

const handleInitialize = (id) => jsonRpcResult(id, {
  protocolVersion: '2024-11-05',
  capabilities: { tools: {} },
  serverInfo: { name: 'megamem', version: '1.0.0' }
})

const handleToolsList = (id) => jsonRpcResult(id, { tools: MEMORY_TOOLS })

const toolCallText = (text) => ({ content: [{ type: 'text', text }] })
const toolCallError = (message) => ({ content: [{ type: 'text', text: `Error: ${message}` }], isError: true })

const callMemorySearch = async (args) => {
  const { query, topK = 5 } = args
  const sessionId = resolveSessionId(args.sessionId)

  if (!query) {
    throw new Error('memory_search requires query')
  }

  const memories = await retrieveMemory(query, sessionId, topK)
  return toolCallText(JSON.stringify({
    count: memories.length,
    memories: memories.map(m => ({ text: m.text, score: m.score }))
  }, null, 2))
}

const callMemorySave = async (args) => {
  const { text } = args
  const sessionId = resolveSessionId(args.sessionId)

  if (!text) {
    throw new Error('memory_save requires text')
  }

  if (text.length > MEMORY_SAVE_MAX_CHARS) {
    throw new Error(
      `memory_save input is ${text.length} chars, exceeds ${MEMORY_SAVE_MAX_CHARS} char limit. ` +
      `Use memory_extract for long conversations or documents.`
    )
  }

  const existing = await Memory.findOne({ sessionId, text: text.trim() })
  if (existing) {
    return toolCallText(JSON.stringify({
      action: 'skip',
      memoryId: existing._id.toString(),
      text: existing.text,
      reason: 'Exact duplicate already exists.'
    }))
  }

  const decision = await detectMemoryConflict({
    memory: { text, confidence: 1, type: 'other' },
    sessionId
  })

  const applied = await applyMemoryDecision({
    decision,
    sessionId,
    fallbackText: text
  })

  return toolCallText(JSON.stringify({
    action: applied.action,
    memoryId: applied.memory?._id?.toString() || null,
    text: applied.memory?.text || null,
    reason: applied.reason
  }, null, 2))
}

const callMemoryExtract = async (args) => {
  const { text } = args
  const sessionId = resolveSessionId(args.sessionId)

  if (!text) {
    throw new Error('memory_extract requires text')
  }

  if (text.length > MEMORY_EXTRACT_MAX_CHARS) {
    throw new Error(`memory_extract input is ${text.length} chars, exceeds ${MEMORY_EXTRACT_MAX_CHARS} char limit. Please split your input into smaller pieces or summarize before extracting.`)
  }

  const results = await persistExtractedMemories({
    conversation: text,
    sessionId
  })

  const summary = {
    chunkCount: 0,
    extractedCount: results.length,
    created: results.filter(r => r.action === 'create').length,
    updated: results.filter(r => r.action === 'update').length,
    skipped: results.filter(r => r.action === 'skip').length,
    results
  }

  return toolCallText(JSON.stringify(summary, null, 2))
}

const callMemoryList = async (args) => {
  const { limit = 20, cursor } = args
  const sessionId = resolveSessionId(args.sessionId)

  const filter = { sessionId }

  if (cursor) {
    try {
      filter._id = { $lt: new mongoose.Types.ObjectId(cursor) }
    } catch {
      throw new Error(`Invalid cursor: "${cursor}" is not a valid ObjectId`)
    }
  }

  const memories = await Memory.find(filter)
    .sort({ _id: -1 })
    .limit(limit + 1)
    .select('text createdAt updatedAt')

  const hasMore = memories.length > limit
  if (hasMore) memories.pop()

  const nextCursor = hasMore ? memories[memories.length - 1]._id.toString() : null

  return toolCallText(JSON.stringify({
    count: memories.length,
    nextCursor,
    memories: memories.map(m => ({
      memoryId: m._id.toString(),
      text: m.text,
      createdAt: m.createdAt,
      updatedAt: m.updatedAt
    }))
  }, null, 2))
}

const callMemoryDelete = async (args) => {
  const { memoryId } = args

  if (!memoryId) {
    throw new Error('memory_delete requires memoryId')
  }

  const result = await Memory.findByIdAndDelete(memoryId)

  if (!result) {
    throw new Error(`Memory not found: ${memoryId}`)
  }

  return toolCallText(JSON.stringify({ deleted: true, memoryId, text: result.text }, null, 2))
}

const TOOL_HANDLERS = {
  memory_search: callMemorySearch,
  memory_save: callMemorySave,
  memory_extract: callMemoryExtract,
  memory_list: callMemoryList,
  memory_delete: callMemoryDelete
}

const handleToolsCall = async (id, params) => {
  const { name, arguments: args = {} } = params || {}

  if (!name) {
    return jsonRpcError(id, -32602, 'Invalid params: missing tool name')
  }

  const handler = TOOL_HANDLERS[name]

  if (!handler) {
    return jsonRpcError(id, -32601, `Unknown tool: ${name}`)
  }

  try {
    const content = await handler(args)
    return jsonRpcResult(id, content)
  } catch (error) {
    return jsonRpcResult(id, toolCallError(error.message))
  }
}

const handleJsonRpc = async (body) => {
  if (!body || body.jsonrpc !== '2.0' || typeof body.method !== 'string') {
    return jsonRpcError(body?.id ?? null, -32600, 'Invalid Request')
  }

  const { id, method, params } = body

  switch (method) {
    case 'initialize':
      return handleInitialize(id)
    case 'notifications/initialized':
      return null
    case 'tools/list':
      return handleToolsList(id)
    case 'tools/call':
      return handleToolsCall(id, params)
    case 'ping':
      return jsonRpcResult(id, {})
    default:
      return jsonRpcError(id, -32601, `Method not found: ${method}`)
  }
}

module.exports = {
  MEMORY_TOOLS,
  handleJsonRpc,
  TOOL_HANDLERS
}
