const fs = require('fs')
const os = require('os')
const path = require('path')
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true })

const SERVER_NAME = 'megamem'
const REQUIRED_ENV = ['MONGO_URI', 'GROQ_API_KEY', 'HUGGINGFACE_API_KEY']

const repoRoot = path.join(__dirname, '..')
const mcpServerPath = path.resolve(repoRoot, 'src', 'mcpServer.js')
const envPath = path.join(repoRoot, '.env')
const cursorDir = path.join(os.homedir(), '.cursor')
const mcpJsonPath = path.join(cursorDir, 'mcp.json')

const megamemEntry = () => ({
  command: 'node',
  args: [mcpServerPath]
})

const parseArgs = (argv) => {
  const flags = new Set(argv.slice(2))
  const unknown = [...flags].filter((flag) => flag !== '--dry-run' && flag !== '--remove')
  if (unknown.length > 0) {
    throw new Error(`Unknown flag: ${unknown[0]}. Use --dry-run or --remove.`)
  }
  return {
    dryRun: flags.has('--dry-run'),
    remove: flags.has('--remove')
  }
}

const assertEnvReady = () => {
  if (!fs.existsSync(envPath)) {
    throw new Error(`Missing ${envPath}. Copy .env.example to .env and fill in your keys.`)
  }

  const missing = REQUIRED_ENV.filter((key) => !String(process.env[key] || '').trim())
  if (missing.length > 0) {
    throw new Error(`Empty or missing in .env: ${missing.join(', ')}`)
  }
}

const readMcpConfig = () => {
  if (!fs.existsSync(mcpJsonPath)) {
    return { mcpServers: {} }
  }

  const raw = fs.readFileSync(mcpJsonPath, 'utf8').trim()
  if (!raw) return { mcpServers: {} }

  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(`Invalid JSON in ${mcpJsonPath}: ${error.message}`, { cause: error })
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${mcpJsonPath} must contain a JSON object`)
  }

  const mcpServers = parsed.mcpServers && typeof parsed.mcpServers === 'object' && !Array.isArray(parsed.mcpServers)
    ? parsed.mcpServers
    : {}

  return { ...parsed, mcpServers }
}

const writeMcpConfig = (config) => {
  fs.mkdirSync(cursorDir, { recursive: true })
  fs.writeFileSync(mcpJsonPath, JSON.stringify(config, null, 2) + '\n')
}

const main = () => {
  const { dryRun, remove } = parseArgs(process.argv)

  if (!remove) assertEnvReady()

  const config = readMcpConfig()

  if (remove) {
    delete config.mcpServers[SERVER_NAME]
  } else {
    config.mcpServers[SERVER_NAME] = megamemEntry()
  }

  if (dryRun) {
    process.stdout.write(JSON.stringify(config, null, 2) + '\n')
    return
  }

  writeMcpConfig(config)

  if (remove) {
    console.log(`Removed "${SERVER_NAME}" from ${mcpJsonPath}`)
  } else {
    console.log(`Wrote "${SERVER_NAME}" to ${mcpJsonPath}`)
    console.log(`Command: node ${mcpServerPath}`)
    console.log('Secrets stay in the repo .env file. Restart Cursor if MegaMem is already loaded.')
  }
}

try {
  main()
} catch (error) {
  console.error(error.message)
  process.exit(1)
}
