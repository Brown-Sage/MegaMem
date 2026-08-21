const { z } = require('zod')
const { MEMORY_TYPES } = require('../constants/memoryTypes')

const scopeSchema = z.enum(['user', 'workspace'])
const memoryTypeSchema = z.enum(MEMORY_TYPES)

const memoryIdSchema = z
  .string()
  .regex(/^[a-fA-F0-9]{24}$/, 'must be a valid 24-character ObjectId')

const sessionIdSchema = z
  .string()
  .min(1)
  .max(100)

const querySchema = z
  .string()
  .min(1)
  .max(2000)

const topKSchema = z
  .number()
  .int()
  .min(1)
  .max(20)

const limitSchema = z
  .number()
  .int()
  .min(1)
  .max(100)

const cursorSchema = z
  .string()
  .regex(/^[a-fA-F0-9]{24}$/, 'must be a valid 24-character ObjectId')

const MEMORY_SAVE_MAX_CHARS = 2000
const MEMORY_EXTRACT_MAX_CHARS = 50000

const chatBodySchema = z.object({
  query: querySchema,
  sessionId: sessionIdSchema,
  topK: topKSchema.optional()
}).strict()

const toolArgsSchema = {
  memory_search: z.object({
    query: querySchema,
    sessionId: sessionIdSchema.optional(),
    topK: topKSchema.optional()
  }).strict(),

  memory_save: z.object({
    text: z.string().min(1).max(MEMORY_SAVE_MAX_CHARS),
    sessionId: sessionIdSchema.optional(),
    type: memoryTypeSchema.optional(),
    scope: scopeSchema.optional()
  }).strict(),

  memory_extract: z.object({
    text: z.string().min(1).max(MEMORY_EXTRACT_MAX_CHARS),
    sessionId: sessionIdSchema.optional(),
    scope: scopeSchema.optional()
  }).strict(),

  memory_list: z.object({
    sessionId: sessionIdSchema.optional(),
    limit: limitSchema.optional(),
    cursor: cursorSchema.optional()
  }).strict(),

  memory_delete: z.object({
    memoryId: memoryIdSchema
  }).strict(),

  memory_profile: z.object({
    sessionId: sessionIdSchema.optional(),
    refresh: z.boolean().optional()
  }).strict()
}

const validate = (schema, value) => {
  const result = schema.safeParse(value)
  if (result.success) {
    return { ok: true, data: result.data }
  }
  return {
    ok: false,
    errors: result.error.issues.map((issue) => ({
      path: issue.path.join('.') || 'body',
      message: issue.message
    }))
  }
}

module.exports = {
  validate,
  chatBodySchema,
  toolArgsSchema,
  MEMORY_SAVE_MAX_CHARS,
  MEMORY_EXTRACT_MAX_CHARS
}
