const isQuiet = () => process.env.MEGAMEM_QUIET === '1' || process.env.MEGAMEM_QUIET === 'true'

const log = (...args) => {
  if (isQuiet()) return
  console.error(...args)
}

module.exports = { log, isQuiet }
