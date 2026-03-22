// ============================================================
// src/middleware/auth.js
// Production authentication — checks API key against database
// Attaches full client object to request
// ============================================================

const { supabase } = require('../config/database')
const logger = require('../config/logger')
const config = require('../config/env')

// Cache client lookups for 60 seconds to reduce database queries
// A client doing 100 requests/minute should not hit the DB 100 times
const clientCache = new Map()
const CACHE_TTL = 60 * 1000  // 60 seconds

async function getClientByApiKey(apiKey) {
  // Check cache first
  const cacheKey = apiKey
  const cached = clientCache.get(cacheKey)

  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.client
  }

  // Query database
  const { data, error } = await supabase
    .from('clients')
    .select('*')
    .eq('api_key', apiKey)
    .single()

  if (error || !data) return null

  // Store in cache
  clientCache.set(cacheKey, {
    client: data,
    timestamp: Date.now()
  })

  // Clean old cache entries periodically
  if (clientCache.size > 1000) {
    const now = Date.now()
    for (const [key, value] of clientCache.entries()) {
      if (now - value.timestamp > CACHE_TTL) {
        clientCache.delete(key)
      }
    }
  }

  return data
}

// Clear cache when client data changes (call this after any client update)
function invalidateClientCache(apiKey) {
  clientCache.delete(apiKey)
}

// ── MAIN AUTH MIDDLEWARE ──────────────────────────────────
async function authenticateApiKey(req, res, next) {
  const startTime = Date.now()

  // Extract API key from Authorization header
  const authHeader = req.headers['authorization']

  if (!authHeader) {
    return res.status(401).json({
      error: 'Authentication required',
      code: 'MISSING_API_KEY',
      help: 'Include header: Authorization: Bearer YOUR_API_KEY'
    })
  }

  const parts = authHeader.split(' ')
  if (parts.length !== 2 || parts[0] !== 'Bearer') {
    return res.status(401).json({
      error: 'Invalid authorization format',
      code: 'INVALID_AUTH_FORMAT',
      help: 'Format must be: Authorization: Bearer YOUR_API_KEY'
    })
  }

  const apiKey = parts[1]

  // Basic key format validation before DB query
  if (!apiKey.startsWith('nk_live_') && !apiKey.startsWith('nk_test_')) {
    return res.status(401).json({
      error: 'Invalid API key format',
      code: 'INVALID_KEY_FORMAT'
    })
  }

  try {
    const client = await getClientByApiKey(apiKey)

    if (!client) {
      logger.auth('INVALID_KEY', {
        ip: req.ip,
        key: apiKey.substring(0, 12) + '...'  // Log partial key only
      })

      return res.status(401).json({
        error: 'Invalid API key',
        code: 'INVALID_API_KEY'
      })
    }

    // Check account status
    if (client.status === 'suspended') {
      return res.status(403).json({
        error: 'Account suspended',
        code: 'ACCOUNT_SUSPENDED',
        message: 'Contact support@nook.ma to resolve'
      })
    }

    if (client.status === 'pending') {
      return res.status(403).json({
        error: 'Account pending verification',
        code: 'ACCOUNT_PENDING',
        message: 'Check your email for verification instructions'
      })
    }

    // Check if this is a test key being used in production
    if (apiKey.startsWith('nk_test_') && config.server.isProd) {
      return res.status(403).json({
        error: 'Test API keys cannot be used in production',
        code: 'TEST_KEY_IN_PRODUCTION',
        help: 'Use your live API key for production requests'
      })
    }

    // Attach client to request
    req.client = client
    req.clientId = client.id

    const authTime = Date.now() - startTime
    if (authTime > 100) {
      logger.warn('Slow auth query', { ms: authTime, clientId: client.id })
    }

    next()

  } catch (err) {
    logger.error('Auth middleware error', { error: err.message })
    return res.status(500).json({
      error: 'Authentication service error',
      code: 'AUTH_ERROR'
    })
  }
}

// ── ADMIN AUTHENTICATION ──────────────────────────────────
// For internal admin endpoints only
function authenticateAdmin(req, res, next) {
  const adminKey = req.headers['x-admin-key']

  if (!adminKey || adminKey !== config.security.adminApiKey) {
    return res.status(403).json({
      error: 'Admin access required',
      code: 'FORBIDDEN'
    })
  }

  next()
}

// ── WEBHOOK VERIFICATION ─────────────────────────────────
// Verifies that webhook calls are from Africa's Talking
// Uses HMAC signature verification
function verifyWebhook(req, res, next) {
  const crypto = require('crypto')
  const signature = req.headers['x-africastalking-signature']

  if (!signature) {
    // Africa's Talking may not always send signatures
    // In production, make this required
    return next()
  }

  const hash = crypto
    .createHmac('sha256', config.security.webhookSecret)
    .update(JSON.stringify(req.body))
    .digest('hex')

  if (hash !== signature) {
    logger.warn('Invalid webhook signature', { ip: req.ip })
    return res.status(401).json({ error: 'Invalid webhook signature' })
  }

  next()
}

module.exports = {
  authenticateApiKey,
  authenticateAdmin,
  verifyWebhook,
  invalidateClientCache
}
