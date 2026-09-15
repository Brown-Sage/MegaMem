const { test, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

const ENV_MODULE = require.resolve('../../src/config/env')
const COMMON_MODULE = require.resolve('../../.cursor/hooks/common')

let home

// The module loads an .env file on require, so each case needs a fresh copy
// pointed at a throwaway MEGAMEM_HOME.
const freshEnv = () => {
  delete require.cache[ENV_MODULE]
  delete require.cache[COMMON_MODULE]
  return {
    env: require('../../src/config/env'),
    common: require('../../.cursor/hooks/common')
  }
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'megamem-env-'))
  process.env.MEGAMEM_HOME = home
  delete process.env.MEGAMEM_TEST_KEY
})

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true })
  delete process.env.MEGAMEM_HOME
  delete process.env.MEGAMEM_TEST_KEY
  delete require.cache[ENV_MODULE]
  delete require.cache[COMMON_MODULE]
})

test('megamemHome honors MEGAMEM_HOME and defaults under the home directory', () => {
  const { env } = freshEnv()
  assert.equal(env.megamemHome(), home)

  delete process.env.MEGAMEM_HOME
  const { env: defaulted } = freshEnv()
  assert.equal(defaulted.megamemHome(), path.join(os.homedir(), '.megamem'))
})

test('homeEnvPath and repoEnvPath point at the config files', () => {
  const { env } = freshEnv()
  assert.equal(env.homeEnvPath(), path.join(home, '.env'))
  assert.equal(env.repoEnvPath(), path.join(env.PACKAGE_ROOT, '.env'))
})

test('loads the home .env so a global install works without the repo', () => {
  fs.writeFileSync(path.join(home, '.env'), 'MEGAMEM_TEST_KEY=from-home\n')
  const { env } = freshEnv()
  assert.equal(process.env.MEGAMEM_TEST_KEY, 'from-home')
  assert.equal(env.loadedEnvFiles[0], path.join(home, '.env'))
})

test('reads the home file before the repo file', () => {
  const { env } = freshEnv()
  assert.deepEqual(env.envFiles(), [env.homeEnvPath(), env.repoEnvPath()])
})

test('a missing home .env falls through without throwing', () => {
  const { env } = freshEnv()
  assert.ok(!env.loadedEnvFiles.includes(path.join(home, '.env')))
})

test('real environment variables are never overridden by either file', () => {
  fs.writeFileSync(path.join(home, '.env'), 'MEGAMEM_TEST_KEY=from-home\n')
  process.env.MEGAMEM_TEST_KEY = 'from-process'
  freshEnv()
  // Cursor's sessionStart `env` output and shell exports must win over disk.
  assert.equal(process.env.MEGAMEM_TEST_KEY, 'from-process')
})

test('claimSessionOnce lets exactly one hook run per session and workspace', () => {
  const { common } = freshEnv()
  const payload = { session_id: 'conv-1', workspace_roots: ['/tmp/project-a'] }

  const first = common.claimSessionOnce('session-start', payload)
  assert.equal(first.claimed, true)

  const second = common.claimSessionOnce('session-start', payload)
  assert.equal(second.claimed, false)

  // Releasing (nothing was injected) hands the claim to the other hook.
  first.release()
  assert.equal(common.claimSessionOnce('session-start', payload).claimed, true)
})

test('claimSessionOnce separates kind, session, and workspace', () => {
  const { common } = freshEnv()
  const payload = { session_id: 'conv-1', workspace_roots: ['/tmp/project-a'] }
  assert.equal(common.claimSessionOnce('session-start', payload).claimed, true)

  assert.equal(common.claimSessionOnce('session-end', payload).claimed, true)
  assert.equal(common.claimSessionOnce('session-start', { ...payload, session_id: 'conv-2' }).claimed, true)
  assert.equal(common.claimSessionOnce('session-start', { ...payload, workspace_roots: ['/tmp/project-b'] }).claimed, true)
})

test('claimSessionOnce state lives under the configured home, not the repo', () => {
  const { common } = freshEnv()
  assert.equal(common.stateDir(), path.join(home, 'state'))
  common.claimSessionOnce('session-start', { session_id: 'x', workspace_roots: ['/tmp/p'] })
  assert.ok(fs.existsSync(path.join(home, 'state', 'hooks')))
})
