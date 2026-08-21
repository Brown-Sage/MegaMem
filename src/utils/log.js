const pino = require('pino')

// stderr-only so the MCP stdio transport stays clean (stdout is protocol).
const level = process.env.LOG_LEVEL
  || (process.env.MEGAMEM_QUIET === '1' || process.env.MEGAMEM_QUIET === 'true'
    ? 'silent'
    : 'info')

const logger = pino({ level }, pino.destination(2))

// Back-compat: log(...) behaved like console.error with format strings.
const log = (...args) => {
  if (typeof args[0] === 'string' && args.length > 1) {
    logger.info(args[0], ...args.slice(1))
  } else {
    logger.info(...args)
  }
}

const child = (module) => logger.child({ mod: module })

module.exports = { logger, log, child, isQuiet: () => level === 'silent' }
