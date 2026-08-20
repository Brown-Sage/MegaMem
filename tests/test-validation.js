const { validate, chatBodySchema, toolArgsSchema } = require('../src/validation/schemas')

const expectOk = (result, label) => {
  if (!result.ok) {
    console.error(`FAIL: ${label} — expected ok, got ${JSON.stringify(result.errors)}`)
    process.exitCode = 1
  } else {
    console.log(`PASS: ${label}`)
  }
}

const expectError = (result, label) => {
  if (result.ok) {
    console.error(`FAIL: ${label} — expected error, got ok`)
    process.exitCode = 1
  } else {
    console.log(`PASS: ${label}`)
  }
}

console.log('--- chat body validation ---')

expectOk(
  validate(chatBodySchema, { query: 'hello', sessionId: 'abc' }),
  'valid chat body'
)
expectOk(
  validate(chatBodySchema, { query: 'hello', sessionId: 'abc', topK: 5 }),
  'valid chat body with topK'
)
expectError(
  validate(chatBodySchema, { sessionId: 'abc' }),
  'missing query'
)
expectError(
  validate(chatBodySchema, { query: 'hello' }),
  'missing sessionId'
)
expectError(
  validate(chatBodySchema, { query: 'hello', sessionId: 'abc', topK: 100 }),
  'topK above max'
)
expectError(
  validate(chatBodySchema, { query: 'hello', sessionId: 'abc', extra: true }),
  'unknown field rejected'
)
expectError(
  validate(chatBodySchema, null),
  'null body rejected'
)
expectError(
  validate(chatBodySchema, { query: 123, sessionId: 'abc' }),
  'non-string query rejected'
)

console.log('\n--- tool arg validation ---')

expectOk(
  validate(toolArgsSchema.memory_search, { query: 'preference' }),
  'memory_search valid'
)
expectError(
  validate(toolArgsSchema.memory_search, {}),
  'memory_search missing query'
)
expectError(
  validate(toolArgsSchema.memory_search, { query: 'x', topK: 0 }),
  'memory_search topK below min'
)

expectOk(
  validate(toolArgsSchema.memory_save, { text: 'likes coffee' }),
  'memory_save valid'
)
expectError(
  validate(toolArgsSchema.memory_save, { text: 'x'.repeat(2001) }),
  'memory_save text too long'
)

expectOk(
  validate(toolArgsSchema.memory_extract, { text: 'long document' }),
  'memory_extract valid'
)
expectError(
  validate(toolArgsSchema.memory_extract, { text: 'x'.repeat(50001) }),
  'memory_extract text too long'
)

expectOk(
  validate(toolArgsSchema.memory_list, {}),
  'memory_list empty args valid'
)
expectOk(
  validate(toolArgsSchema.memory_list, { limit: 50, cursor: 'a'.repeat(24) }),
  'memory_list with limit and cursor'
)
expectError(
  validate(toolArgsSchema.memory_list, { limit: 0 }),
  'memory_list limit below min'
)
expectError(
  validate(toolArgsSchema.memory_list, { cursor: 'not-an-objectid' }),
  'memory_list invalid cursor'

)
expectError(
  validate(toolArgsSchema.memory_delete, {}),
  'memory_delete missing memoryId'
)
expectOk(
  validate(toolArgsSchema.memory_delete, { memoryId: 'a'.repeat(24) }),
  'memory_delete valid'
)
