// Central HTTP error shape + async route wrapper.
// Every handler either returns JSON via res or throws; thrown errors are
// converted to structured responses by the top-level errorHandler.

class HttpError extends Error {
  constructor (status, message, code = 'internal_error', details = undefined) {
    super(message)
    this.status = status
    this.code = code
    this.details = details
  }
}

const asyncRoute = (handler) => (req, res, next) => {
  Promise.resolve(handler(req, res)).catch(next)
}

const notFound = (req, res) => {
  res.status(404).json({ error: { code: 'not_found', message: `No route: ${req.method} ${req.path}` } })
}

// eslint-disable-next-line no-unused-vars
const errorHandler = (err, req, res, next) => {
  // express.json() surfaces malformed bodies as a SyntaxError with status 4xx
  // attached — normalize it into the standard error shape.
  if (err?.type === 'entity.parse.failed' || (err instanceof SyntaxError && err.status === 400)) {
    return res.status(400).json({
      error: { code: 'malformed_json', message: 'Request body is not valid JSON' }
    })
  }
  if (err?.type === 'entity.too.large') {
    return res.status(413).json({
      error: { code: 'payload_too_large', message: `Request body exceeds ${err.limit || 'the'} byte limit` }
    })
  }

  const status = err instanceof HttpError ? err.status : 500
  const isClientError = status < 500
  if (!isClientError) {
    // Server-side failures are logged with stack; client errors are expected
    // input problems and stay at one line.
    req.log?.error({ err: err.message, stack: err.stack, path: req.path }, 'request failed')
  } else {
    req.log?.warn({ err: err.message, path: req.path }, 'request rejected')
  }
  res.status(status).json({
    error: {
      code: err.code || 'internal_error',
      message: isClientError ? err.message : 'Internal server error'
    }
  })
}

module.exports = { HttpError, asyncRoute, notFound, errorHandler }
