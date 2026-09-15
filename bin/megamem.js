#!/usr/bin/env node
const { spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const dotenv = require('dotenv')

const PACKAGE_ROOT = path.resolve(__dirname, '..')
const REQUIRED_KEYS = ['MONGO_URI', 'GROQ_API_KEY', 'HUGGINGFACE_API_KEY']

const log = (msg) => console.log(msg)

const usage = () => log(`
megamem — persistent memory for AI coding assistants

Usage:
  megamem setup        Install globally: MCP server + Cursor hooks, every project
  megamem status       Show which memory layers this directory resolves to
  megamem doctor       Check config, connectivity, and the global install
  megamem mcp          Run the MCP stdio server (for manual wiring)
  megamem uninstall    Undo the global install

Options:
  --purge              uninstall: also delete ~/.megamem/.env
`)

const requireEnv = () => require(path.join(PACKAGE_ROOT, 'src', 'config', 'env'))

// Values as they will actually be seen by Cursor-launched processes, which is
// what matters — not whatever this shell happens to export.
const readEnvFile = (file) => {
  try {
    return dotenv.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return {}
  }
}

const setup = () => {
  const { install } = require(path.join(PACKAGE_ROOT, 'scripts', 'install-global.js'))
  const { homeEnvPath } = requireEnv()

  const result = install()

  log('\nMegaMem installed globally.\n')
  log(`  config     ${homeEnvPath()} (${result.env.action})`)
  log(`  MCP        ${result.mcpJson}`)
  log(`  hooks      ${result.hooksJson}`)
  for (const launcher of result.launchers) log(`             ${launcher}`)

  if (result.env.action === 'copied-repo') {
    log(`\n  note: your keys were copied from the repo .env. ${homeEnvPath()} is now the source of truth.`)
  }

  // Validate the file the install actually reads. Checking process.env here was
  // a false positive: a shell that exports these says nothing about whether
  // Cursor can find them, and Cursor does not inherit your shell environment.
  const configured = readEnvFile(homeEnvPath())
  const missing = REQUIRED_KEYS.filter((key) => !String(configured[key] || '').trim())

  if (missing.length === 0) {
    log('\n  Keys look complete. Verify with: megamem doctor')
  } else {
    log(`\n  ! ${missing.join(', ')} missing from ${homeEnvPath()}`)
    log('    Cursor does not inherit your shell environment, so these must be in that file.')
    log('    Fill them in, then run: megamem doctor')

    const exportedButNotSaved = REQUIRED_KEYS.filter((key) =>
      String(process.env[key] || '').trim() && !String(configured[key] || '').trim())
    if (exportedButNotSaved.length > 0) {
      log(`    (${exportedButNotSaved.join(', ')} are exported in this shell — copy them into the file)`)
    }
  }

  log('\nRestart Cursor, then open any project — memory works there too.\n')
}

const status = () => {
  const { resolveSessionIds } = require(path.join(PACKAGE_ROOT, 'src', 'utils', 'sessionId'))
  const { envFiles, loadedEnvFiles, megamemHome } = requireEnv()

  const layers = resolveSessionIds()
  log(`\ncwd            ${process.cwd()}`)
  log(`user layer     ${layers.userId}`)
  log(`workspace      ${layers.workspaceId}`)
  log(`megamem home   ${megamemHome()}`)
  log(`config files   ${envFiles().join(', ')}`)
  log(`loaded         ${loadedEnvFiles.length > 0 ? loadedEnvFiles.join(', ') : '(none)'}\n`)
}

const doctor = () => {
  const result = spawnSync(
    process.execPath,
    [path.join(PACKAGE_ROOT, 'scripts', 'doctor.js'), ...process.argv.slice(3)],
    { stdio: 'inherit' }
  )
  process.exit(result.status === null ? 1 : result.status)
}

const mcp = () => {
  require(path.join(PACKAGE_ROOT, 'src', 'mcpServer.js'))
}

const uninstall = () => {
  const { uninstall: run } = require(path.join(PACKAGE_ROOT, 'scripts', 'install-global.js'))
  const purge = process.argv.includes('--purge')
  const removed = run({ purge })

  if (removed.length === 0) {
    log('\nNothing to remove — MegaMem was not installed globally.\n')
    return
  }

  log('\nRemoved:')
  for (const item of removed) log(`  ${item}`)
  if (!purge) log('\n  (~/.megamem/.env kept — pass --purge to delete it)')
  log('\nRestart Cursor for the change to take effect.\n')
}

const COMMANDS = { setup, status, doctor, mcp, uninstall }

const main = () => {
  const command = process.argv[2]

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    usage()
    return
  }

  const handler = COMMANDS[command]
  if (!handler) {
    console.error(`Unknown command: ${command}`)
    usage()
    process.exit(1)
  }

  handler()
}

try {
  main()
} catch (error) {
  console.error(error.message)
  process.exit(1)
}
