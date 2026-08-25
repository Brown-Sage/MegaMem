const { test } = require('node:test')
const assert = require('node:assert')
const { isProfileStale, REFRESH_AFTER_NEW_MEMORIES } = require('../../src/services/profileService')

test('isProfileStale: fresh while new memories below refresh threshold', () => {
  assert.equal(isProfileStale({ cachedMemoryCount: 10, memoryCount: 10 + REFRESH_AFTER_NEW_MEMORIES - 1 }), false)
})

test('isProfileStale: stale once new memories reach the refresh threshold', () => {
  assert.equal(isProfileStale({ cachedMemoryCount: 10, memoryCount: 10 + REFRESH_AFTER_NEW_MEMORIES }), true)
})

test('isProfileStale regression: deletions (count below watermark) are stale, not fresh', () => {
  // Old logic: memoryCount - cachedMemoryCount < threshold → treated fresh
  // forever, so a profile asserting a deleted fact never refreshed.
  assert.equal(isProfileStale({ cachedMemoryCount: 20, memoryCount: 19 }), true)
  assert.equal(isProfileStale({ cachedMemoryCount: 20, memoryCount: 5 }), true)
})

test('isProfileStale: missing cached count behaves like zero baseline', () => {
  assert.equal(isProfileStale({ memoryCount: REFRESH_AFTER_NEW_MEMORIES - 1 }), false)
  assert.equal(isProfileStale({ memoryCount: REFRESH_AFTER_NEW_MEMORIES }), true)
})
