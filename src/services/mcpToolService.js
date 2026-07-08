const { retrieveMemory } = require('./retrieveService')
const { saveMemory, updateMemory, applyMemoryDecision } = require('./memoryService')
const { detectMemoryConflict } = require('./conflictService')
const { persistExtractedMemories } = require('./memoryChatService')
const Memory = require('../models/Memory')

const MEMORY_SAVE_MAX_CHARS = 2000

const MEMORY_TOOLS = [
  {
    name: 'memory_search',
    description: 'Search stored memories for a session using semantic similarity. Returns the top matching memories with relevance scores.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to search for' },
        sessionId: { type: 'string', description: 'Session identifier to scope the search' },
        topK: { type: 'number', description: 'How many memories to return (default 5)' }
      },
      required: ['query', 'sessionId']
    }
  },
  {
    name: 'memory_save',
    description: 'Save a single concise fact to a session. Runs conflict detection: if a similar memory exists, returns a decision (create/update/ignore). Rejects inputs longer than 2000 characters — use memory_extract for long text.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The memory text to save (must be a single concise fact, max 2000 chars)' },
        sessionId: { type: 'string', description: 'Session identifier' }
      },
      required: ['text', 'sessionId']
    }
  },
  {
    name: 'memory_extract',
    description: 'Run the full auto-memory pipeline on a long conversation or document. Chunks the input, runs extraction LLM on each chunk, dedupes facts, runs conflict detection on each fact, and persists the results. Returns the actions taken.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The conversation or document text to extract memories from' },
        sessionId: { type: 'string', description: 'Session identifier' }
      },
      required: ['text', 'sessionId']
    }
  },
  {
    name: 'memory_list',
    description: 'List all memories stored in a session, ordered by most recently updated.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Session identifier' },
        limit: { type: 'number', description: 'Maximum number of memories to return (default 20)' }
      },
      required: ['sessionId']
    }
  },
  {
    name: 'memory_delete',
    description: 'Delete a single memory by its ID. Returns confirmation.',
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
  const { query, sessionId, topK = 5 } = args

  if (!query || !sessionId) {
    throw new Error('memory_search requires query and sessionId')
  }

  const memories = await retrieveMemory(query, sessionId, topK)
  return toolCallText(JSON.stringify({
    count: memories.length,
    memories: memories.map(m => ({ text: m.text, score: m.score }))
  }, null, 2))
}

const callMemorySave = async (args) => {
  const { text, sessionId } = args

  if (!text || !sessionId) {
    throw new Error('memory_save requires text and sessionId')
  }

  if (text.length > MEMORY_SAVE_MAX_CHARS) {
    throw new Error(
      `memory_save input is ${text.length} chars, exceeds ${MEMORY_SAVE_MAX_CHARS} char limit. ` +
      `Use memory_extract for long conversations or documents.`
    )
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
  const { text, sessionId } = args

  if (!text || !sessionId) {
    throw new Error('memory_extract requires text and sessionId')
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
  const { sessionId, limit = 20 } = args

  if (!sessionId) {
    throw new Error('memory_list requires sessionId')
  }

  const memories = await Memory.find({ sessionId })
    .sort({ updatedAt: -1 })
    .limit(limit)
    .select('text createdAt updatedAt -_id')

  return toolCallText(JSON.stringify({
    count: memories.length,
    memories: memories.map(m => ({
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
