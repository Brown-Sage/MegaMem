const { test } = require('node:test')
const assert = require('node:assert')
const { completeChat, isRetryableError, __setClient } = require('../../src/services/groqService')

test('isRetryableError: retryable statuses', () => {
  for (const status of [408, 429, 500, 503]) {
    assert.equal(isRetryableError({ status }), true, `status ${status}`)
  }
})

test('isRetryableError: non-retryable statuses', () => {
  for (const status of [400, 401, 403, 404]) {
    assert.equal(isRetryableError({ status }), false, `status ${status}`)
  }
})

test('isRetryableError: our own timeout is not retryable', () => {
  assert.equal(isRetryableError(new Error('Groq API timeout after 10s')), false)
})

test('isRetryableError: network codes and messages are retryable', () => {
  assert.equal(isRetryableError({ code: 'ECONNRESET' }), true)
  assert.equal(isRetryableError({ code: 'ETIMEDOUT' }), true)
  assert.equal(isRetryableError(new Error('socket hang up')), true)
  assert.equal(isRetryableError({}), false)
})

const okResponse = (content) => ({
  choices: [{ message: { content } }]
})

test('completeChat returns content from the client', async () => {
  const calls = []
  __setClient({
    chat: {
      completions: {
        create: async (params) => {
          calls.push(params)
          return okResponse('hello!')
        }
      }
    }
  })

  const out = await completeChat([{ role: 'user', content: 'hi' }], { maxRetries: 0 })
  assert.equal(out, 'hello!')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].messages[0].content, 'hi')
})

test('completeChat retries transient failures then succeeds', async () => {
  let attempts = 0
  __setClient({
    chat: {
      completions: {
        create: async () => {
          attempts++
          if (attempts < 2) {
            const err = new Error('rate limited')
            err.status = 429
            throw err
          }
          return okResponse('recovered')
        }
      }
    }
  })

  const out = await completeChat([{ role: 'user', content: 'hi' }], { maxRetries: 2 })
  assert.equal(out, 'recovered')
  assert.equal(attempts, 2)
})

test('completeChat gives up after maxRetries on persistent failure', async () => {
  let attempts = 0
  __setClient({
    chat: {
      completions: {
        create: async () => {
          attempts++
          const err = new Error('still down')
          err.status = 500
          throw err
        }
      }
    }
  })

  await assert.rejects(
    () => completeChat([{ role: 'user', content: 'hi' }], { maxRetries: 1 }),
    /still down/
  )
  assert.equal(attempts, 2)
})
