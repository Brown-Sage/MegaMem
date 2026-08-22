const { test } = require('node:test')
const assert = require('node:assert')
const { DEFAULT_USER_ID, currentUserId } = require('../../src/utils/ownership')

test('currentUserId falls back to default when MEGAMEM_USER_ID is unset', () => {
  delete process.env.MEGAMEM_USER_ID
  assert.equal(currentUserId(), DEFAULT_USER_ID)
})

test('currentUserId prefers MEGAMEM_USER_ID when set', () => {
  process.env.MEGAMEM_USER_ID = 'user-abc'
  try {
    assert.equal(currentUserId(), 'user-abc')
  } finally {
    delete process.env.MEGAMEM_USER_ID
  }
})

test('currentUserId ignores empty-string MEGAMEM_USER_ID', () => {
  process.env.MEGAMEM_USER_ID = ''
  try {
    assert.equal(currentUserId(), DEFAULT_USER_ID)
  } finally {
    delete process.env.MEGAMEM_USER_ID
  }
})
