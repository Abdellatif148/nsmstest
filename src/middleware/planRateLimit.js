// ============================================================
// src/middleware/planRateLimit.js
// Different plans get different rate limits
// Basic: 10 req/sec  Standard: 50/sec  Enterprise: 200/sec
// ============================================================

const rateLimit = require('express-rate-limit')

// Store per-client counters
// In production with multiple servers: use Redis store
// For single server: in-memory is fine
const { RateLimiterMemory } = (() => {
  try {
    return require('rate-limiter-flexible')
  } catch {
    return { RateLimiterMemory: null }
  }
})()

const PLAN_LIMITS = {
  basic:      { requests: 10,  window: 1000 },   // 10/second
  standard:   { requests: 50,  window: 1000 },   // 50/second
  enterprise: { requests: 200, window: 1000 },   // 200/second
}

// Simple in-memory tracker (replace with Redis in multi-server setup)
const requestCounts = new Map()

function planRateLimit(req, res, next) {
  if (!req.client) return next()  // Auth middleware runs first

  const plan = req.client.plan || 'basic'
  const limit = PLAN_LIMITS[plan] || PLAN_LIMITS.basic
  const key = req.client.id + ':' + Math.floor(Date.now() / limit.window)

  const current = requestCounts.get(key) || 0

  if (current >= limit.requests) {
    return res.status(429).json({
      error: 'Plan rate limit exceeded',
      code: 'PLAN_RATE_LIMIT',
      limit: limit.requests,
      window: '1 second',
      your_plan: plan,
      upgrade_url: 'https://nook.ma/billing',
      message: `${plan} plan allows ${limit.requests} requests per second`
    })
  }

  requestCounts.set(key, current + 1)

  // Clean old entries every 10 seconds
  if (requestCounts.size > 10000) {
    const cutoff = Math.floor(Date.now() / limit.window) - 5
    for (const [k] of requestCounts) {
      const timestamp = parseInt(k.split(':').pop())
      if (timestamp < cutoff) requestCounts.delete(k)
    }
  }

  // Add rate limit headers so clients can see their usage
  res.setHeader('X-RateLimit-Limit', limit.requests)
  res.setHeader('X-RateLimit-Remaining', limit.requests - current - 1)
  res.setHeader('X-RateLimit-Plan', plan)

  next()
}

module.exports = { planRateLimit, PLAN_LIMITS }
