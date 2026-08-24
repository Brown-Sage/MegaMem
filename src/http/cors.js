// CORS: self-hosted local server — default is same-machine access only.
// Set MEGAMEM_CORS_ORIGINS to a comma-separated allowlist to expose the API
// to browser apps on other origins (e.g. "http://localhost:3000,https://myapp.example").
const DEFAULT_ALLOWED = ['http://localhost', 'http://127.0.0.1', 'null']

const cors = (req, res, next) => {
  const origin = req.headers.origin
  if (origin) {
    let allowed
    const configured = (process.env.MEGAMEM_CORS_ORIGINS || '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)

    if (configured.length > 0) {
      allowed = configured.includes(origin)
    } else {
      // Default: localhost/loopback origins of any port + file:// ("null").
      try {
        const url = new URL(origin)
        allowed = DEFAULT_ALLOWED.includes(`${url.protocol}//${url.hostname}`) ||
          url.hostname === 'localhost' ||
          url.hostname === '127.0.0.1' ||
          url.hostname === '[::1]'
      } catch {
        allowed = origin === 'null'
      }
    }

    if (allowed) {
      res.set('Access-Control-Allow-Origin', origin)
      res.set('Vary', 'Origin')
      res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
      res.set('Access-Control-Allow-Headers', 'Content-Type')
      res.set('Access-Control-Max-Age', '600')
    }
  }

  if (req.method === 'OPTIONS') {
    return res.status(204).send()
  }
  next()
}

module.exports = { cors }
