// Fixed-window in-memory rate limiter keyed by remote address.
// Deliberately dependency-free: single-process self-hosted server, default
// limits are generous (agents can fire bursts legitimately). Configure via
// MEGAMEM_RATE_LIMIT_WINDOW_MS / MEGAMEM_RATE_LIMIT_MAX; set MAX=0 to disable.

const WINDOW_MS = Number(process.env.MEGAMEM_RATE_LIMIT_WINDOW_MS) || 60_000
const MAX_REQUESTS = process.env.MEGAMEM_RATE_LIMIT_MAX !== undefined
  ? Number(process.env.MEGAMEM_RATE_LIMIT_MAX)
  : 120

const hits = new Map()

const rateLimit = (req, res, next) => {
  if (MAX_REQUESTS <= 0) return next()

  const key = req.ip || req.socket?.remoteAddress || 'unknown'
  const now = Date.now()
  let entry = hits.get(key)
  if (!entry || now >= entry.resetAt) {
    entry = { count: 0, resetAt: now + WINDOW_MS }
    hits.set(key, entry)
    // Opportunistic cleanup so idle clients don't leak map entries.
    if (hits.size > 10_000) {
      for (const [k, v] of hits) {
        if (now >= v.resetAt) hits.delete(k)
      }
    }
  }

  entry.count += 1
  res.set('RateLimit-Limit', String(MAX_REQUESTS))
  res.set('RateLimit-Remaining', String(Math.max(0, MAX_REQUESTS - entry.count)))
  res.set('RateLimit-Reset', String(Math.ceil((entry.resetAt - now) / 1000)))

  if (entry.count > MAX_REQUESTS) {
    const retryAfterSec = Math.max(1, Math.ceil((entry.resetAt - now) / 1000))
    res.set('Retry-After', String(retryAfterSec))
    return res.status(429).json({
      error: {
        code: 'rate_limited',
        message: `Too many requests. Retry after ${retryAfterSec}s.`
      }
    })
  }

  next()
}

module.exports = { rateLimit, WINDOW_MS, MAX_REQUESTS }
