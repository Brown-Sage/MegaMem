const fs = require('fs')
const os = require('os')
const path = require('path')
const dotenv = require('dotenv')

// The package root, resolved from this file so it is independent of cwd. Every
// entry point (MCP stdio server, HTTP server, Cursor hooks, extraction worker)
// can be launched from any directory and still find the code and its fallbacks.
const PACKAGE_ROOT = path.resolve(__dirname, '..', '..')

// A global install keeps its keys in ~/.megamem/.env so memories keep working
// after the repo is moved, renamed, or deleted. MEGAMEM_HOME overrides it.
const megamemHome = () => process.env.MEGAMEM_HOME || path.join(os.homedir(), '.megamem')

const homeEnvPath = () => path.join(megamemHome(), '.env')
const repoEnvPath = () => path.join(PACKAGE_ROOT, '.env')

// Order matters only for which file is read first: dotenv never overwrites a
// variable that is already set, so real environment variables (including the
// `env` object a Cursor sessionStart hook returns) always win over both files.
const envFiles = () => [homeEnvPath(), repoEnvPath()]

const loadEnv = () => envFiles().filter((file) => {
  if (!fs.existsSync(file)) return false
  dotenv.config({ path: file, quiet: true })
  return true
})

// Loaded on require so every caller keeps the single-line import it had before.
const loadedEnvFiles = loadEnv()

module.exports = {
  PACKAGE_ROOT,
  megamemHome,
  homeEnvPath,
  repoEnvPath,
  envFiles,
  loadEnv,
  loadedEnvFiles
}
