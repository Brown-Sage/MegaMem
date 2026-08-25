const { test, beforeEach, after } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

// Isolated scratch dir per test run.
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'megamem-writelog-test-'))
process.env.MEGAMEM_WRITE_LOG_DIR = SCRATCH

const { recordSessionWrite, readSessionWrites, LOG_DIR } = require('../../src/utils/sessionWriteLog')

after(() => {
  fs.rmSync(SCRATCH, { recursive: true, force: true })
  delete process.env.MEGAMEM_WRITE_LOG_DIR
})

beforeEach(() => {
  for (const f of fs.readdirSync(LOG_DIR)) fs.rmSync(path.join(LOG_DIR, f))
})

test('recorded keys are read back for the same session', () => {
  recordSessionWrite('s1', 'uses-vim')
  recordSessionWrite('s1', 'likes-tea')
  assert.deepEqual(readSessionWrites('s1'), ['uses-vim', 'likes-tea'])
})

test('logs are scoped per session', () => {
  recordSessionWrite('s1', 'uses-vim')
  assert.deepEqual(readSessionWrites('s2'), [])
})

test('missing log degrades to empty list', () => {
  assert.deepEqual(readSessionWrites('never-written'), [])
})

test('invalid args are ignored without writing', () => {
  recordSessionWrite(null, 'x')
  recordSessionWrite('s1', null)
  assert.equal(fs.readdirSync(LOG_DIR).length, 0)
})

test('expired entries are filtered out', () => {
  recordSessionWrite('s1', 'old-fact')
  // Backdate the single entry past the TTL.
  const file = fs.readdirSync(LOG_DIR)
    .map((f) => path.join(LOG_DIR, f))
    .find((f) => fs.readFileSync(f, 'utf8').includes('old-fact'))
  const { ENTRY_TTL_MS } = require('../../src/utils/sessionWriteLog')
  const entry = JSON.parse(fs.readFileSync(file, 'utf8'))
  entry.t = Date.now() - ENTRY_TTL_MS - 1000
  fs.writeFileSync(file, JSON.stringify(entry) + '\n')
  assert.deepEqual(readSessionWrites('s1'), [])
})

test('malformed lines are skipped, valid ones survive', () => {
  recordSessionWrite('s1', 'good-key')
  const files = fs.readdirSync(LOG_DIR).map((f) => path.join(LOG_DIR, f))
  fs.appendFileSync(files[0], '{not json\n\n')
  assert.deepEqual(readSessionWrites('s1'), ['good-key'])
})
