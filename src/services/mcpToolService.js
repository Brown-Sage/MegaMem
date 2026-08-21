const mongoose = require('mongoose')
const { retrieveMemory } = require('./retrieveService')
const { applyMemoryDecision } = require('./memoryService')
const { detectMemoryConflict } = require('./conflictService')
const { persistExtractedMemories } = require('./memoryChatService')
const { getProfile } = require('./profileService')
const { validate, toolArgsSchema } = require('../validation/schemas')
const { resolveSessionIds, targetSessionId, layerLabel } = require('../utils/sessionId')
const { MEMORY_TYPES } = require('../constants/memoryTypes')
const Memory = require('../models/Memory')

const MEMORY_SAVE_MAX_CHARS = 2000
const MEMORY_EXTRACT_MAX_CHARS = 50000

const SERVER_INSTRUCTIONS = `You have persistent memory across conversations via MegaMem.

Memories are two-layer:
- user: personal facts, preferences, identity (default). Omit sessionId.
- workspace: project decisions, constraints, bugs, tasks. Pass type (decision, project_context, constraint, bug, task) or scope="workspace".

Do not pass sessionId unless the user asked for a different bucket.

- BEFORE answering a specific question about the user or this project: call memory_search. Session-start context may already be present; still search when the question is specific.
- IMMEDIATELY: call memory_save when the user states a preference, decision, personal fact, constraint, or stack. Do not ask permission. Personal → default type/other; project decisions → type="decision" or scope="workspace".
- Use memory_extract instead of memory_save for long transcripts or documents.
- Use memory_list to review what is stored and memory_delete to clean up outdated memories.`

const MEMORY_TOOLS = [
  {
    name: 'memory_search',
    description: 'Search stored memories using semantic similarity across the user and workspace layers. Returns the top matching memories with relevance scores and layer labels.\n\nWHEN TO USE: Search memory when the user references a preference, past decision, personal detail, project context, or anything that sounds like prior conversation. Do not search for purely technical questions, math calculations, or one-off requests unrelated to personal context.\n\nsessionId: optional. Omit to search both layers. Only pass sessionId if the user asked for another bucket.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to search for' },
        sessionId: { type: 'string', description: 'Session identifier (optional). Omit to search both layers.' },
        topK: { type: 'number', description: 'How many memories to return (default 5)' }
      },
      required: ['query']
    }
  },
  {
    name: 'memory_save',
    description: 'Save a single concise fact to memory. Runs conflict detection: if a similar memory exists, returns a decision (create/update/ignore). Rejects inputs longer than 2000 characters — use memory_extract for long text.\n\nWHEN TO USE: Proactively save memories whenever the user states a preference, makes a decision, shares a personal fact, mentions a constraint, names a tool or stack they use, or provides any information that would be useful to remember in future conversations. Save automatically without asking for permission first — but the tool call itself should be visible to the user as normal (don\'t suppress or hide the invocation).\n\nPersonal facts: omit type (defaults to other → user layer). Project decisions: type="decision"|"project_context"|"constraint"|"bug"|"task", or scope="workspace".\n\nsessionId: optional. Omit unless the user asked for another bucket.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The memory text to save (must be a single concise fact, max 2000 chars)' },
        sessionId: { type: 'string', description: 'Session identifier (optional). Omit unless the user asked for another bucket.' },
        type: { type: 'string', description: 'Memory type. preference/fact/other → user layer. decision/project_context/constraint/bug/task → workspace layer. Default other.' },
        scope: { type: 'string', description: 'Force layer: user or workspace. Overrides type routing when set.' }
      },
      required: ['text']
    }
  },
  {
    name: 'memory_extract',
    description: 'Run the full auto-memory pipeline on a long conversation or document. Chunks the input, runs extraction LLM on each chunk, deduplicates facts, runs conflict detection on each fact, and persists the results. Personal facts go to the user layer; project decisions go to the workspace layer unless sessionId or scope is set.\n\nWHEN TO USE: Use this INSTEAD of memory_save when you have a long block of text (a conversation transcript, meeting notes, a document) from which multiple facts should be extracted. memory_save is for a single fact; memory_extract is for bulk extraction from rich text.\n\nsessionId: optional. Omit to route by type across both layers.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The conversation or document text to extract memories from' },
        sessionId: { type: 'string', description: 'Session identifier (optional). Omit to route by type across both layers.' },
        scope: { type: 'string', description: 'Force all extracted memories into user or workspace.' }
      },
      required: ['text']
    }
  },
  {
    name: 'memory_list',
    description: 'List memories with cursor-based pagination, ordered by most recently created. Omitting sessionId lists both user and workspace layers.\n\nWHEN TO USE: Use when you need to browse all stored memories, review what\'s been saved, or help the user manage their memory store.\n\nsessionId: optional. Omit to list both layers.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Session identifier (optional). Omit to list both layers.' },
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
  },
  {
    name: 'memory_profile',
    description: 'Get a compiled summary of the user profile plus workspace conventions when enough memories exist. Returns null if there are not enough memories yet.\n\nWHEN TO USE: Use at session start or when the user asks "what do you know about me". Pass refresh=true to force recompilation from the latest memories.\n\nsessionId: optional. Omit to compile user + workspace layers.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Session identifier (optional). Omit to compile user + workspace layers.' },
        refresh: { type: 'boolean', description: 'Force recompile from latest memories (default false)' }
      },
      required: []
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
  serverInfo: { name: 'megamem', version: '1.0.0' },
  instructions: SERVER_INSTRUCTIONS
})

const handleToolsList = (id) => jsonRpcResult(id, { tools: MEMORY_TOOLS })

const toolCallText = (text) => ({ content: [{ type: 'text', text }] })
const toolCallError = (message) => ({ content: [{ type: 'text', text: `Error: ${message}` }], isError: true })

const callMemorySearch = async (args) => {
  const { query, topK = 5 } = args
  const layers = resolveSessionIds(args.sessionId)

  if (!query) {
    throw new Error('memory_search requires query')
  }

  const memories = await retrieveMemory(query, layers.ids, topK)
  if (memories.length === 0) {
    return toolCallText(JSON.stringify({
      count: 0,
      memories: [],
      note: 'No memories passed the relevance threshold.'
    }, null, 2))
  }
  return toolCallText(JSON.stringify({
    count: memories.length,
    memories: memories.map(m => ({
      text: m.text,
      score: m.score,
      layer: m.layer,
      type: m.type,
      sessionId: m.sessionId
    }))
  }, null, 2))
}

const callMemorySave = async (args) => {
  const { text, scope } = args
  const type = MEMORY_TYPES.includes(args.type) ? args.type : 'other'
  const layers = resolveSessionIds(args.sessionId)
  const sessionId = targetSessionId(layers, type, scope)

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
    memory: { text, confidence: 1, type },
    sessionId
  })

  const applied = await applyMemoryDecision({
    decision,
    sessionId,
    fallbackText: text,
    type
  })

  return toolCallText(JSON.stringify({
    action: applied.action,
    memoryId: applied.memory?._id?.toString() || null,
    text: applied.memory?.text || null,
    type: applied.memory?.type || type,
    layer: layerLabel(sessionId, layers),
    sessionId,
    reason: applied.reason
  }, null, 2))
}

const callMemoryExtract = async (args) => {
  const { text, scope } = args
  const layers = resolveSessionIds(args.sessionId)

  if (!text) {
    throw new Error('memory_extract requires text')
  }

  if (text.length > MEMORY_EXTRACT_MAX_CHARS) {
    throw new Error(`memory_extract input is ${text.length} chars, exceeds ${MEMORY_EXTRACT_MAX_CHARS} char limit. Please split your input into smaller pieces or summarize before extracting.`)
  }

  const persistArgs = args.sessionId
    ? { conversation: text, sessionId: args.sessionId, scope }
    : {
      conversation: text,
      userId: layers.userId,
      workspaceId: layers.workspaceId,
      scope
    }

  const results = await persistExtractedMemories(persistArgs)

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
  const layers = resolveSessionIds(args.sessionId)
  const filter = { sessionId: { $in: layers.ids } }

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
    .select('text type sessionId createdAt updatedAt')

  const hasMore = memories.length > limit
  if (hasMore) memories.pop()

  const nextCursor = hasMore ? memories[memories.length - 1]._id.toString() : null

  return toolCallText(JSON.stringify({
    count: memories.length,
    nextCursor,
    memories: memories.map(m => ({
      memoryId: m._id.toString(),
      text: m.text,
      type: m.type || 'other',
      layer: layerLabel(m.sessionId, layers),
      sessionId: m.sessionId,
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

const callMemoryProfile = async (args) => {
  const { refresh = false } = args
  const layers = resolveSessionIds(args.sessionId)

  if (args.sessionId) {
    const profile = await getProfile(args.sessionId, { force: refresh })
    if (!profile) {
      return toolCallText(JSON.stringify({ profile: null, reason: 'Not enough memories yet to compile a profile.' }, null, 2))
    }
    return toolCallText(JSON.stringify({ profile }, null, 2))
  }

  const [profile, workspaceProfile] = await Promise.all([
    getProfile(layers.userId, { force: refresh }),
    getProfile(layers.workspaceId, { force: refresh })
  ])

  if (!profile && !workspaceProfile) {
    return toolCallText(JSON.stringify({ profile: null, workspaceProfile: null, reason: 'Not enough memories yet to compile a profile.' }, null, 2))
  }

  return toolCallText(JSON.stringify({ profile, workspaceProfile }, null, 2))
}

const TOOL_HANDLERS = {
  memory_search: callMemorySearch,
  memory_save: callMemorySave,
  memory_extract: callMemoryExtract,
  memory_list: callMemoryList,
  memory_delete: callMemoryDelete,
  memory_profile: callMemoryProfile
}

const handleToolsCall = async (id, params) => {
  const { name } = params || {}
  let args = (params && params.arguments) || {}

  if (!name) {
    return jsonRpcError(id, -32602, 'Invalid params: missing tool name')
  }

  const handler = TOOL_HANDLERS[name]

  if (!handler) {
    return jsonRpcError(id, -32601, `Unknown tool: ${name}`)
  }

  const schema = toolArgsSchema[name]
  if (schema) {
    const parsed = validate(schema, args)
    if (!parsed.ok) {
      return jsonRpcError(id, -32602, 'Invalid tool arguments', parsed.errors)
    }
    args = parsed.data
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
  SERVER_INSTRUCTIONS,
  handleJsonRpc,
  TOOL_HANDLERS
}
