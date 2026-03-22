// ============================================================
// src/middleware/requestLogger.js
// Logs every request with timing, client ID, and response code
// Helps you debug issues and understand usage patterns
// ============================================================

const logger = require('../config/logger')

function requestLogger(req, res, next) {
  const startTime = Date.now()
  const requestId = require('crypto').randomBytes(8).toString('hex')

  // Attach request ID for tracing through logs
  req.requestId = requestId
  res.setHeader('X-Request-ID', requestId)

  // Log when response finishes
  res.on('finish', () => {
    const duration = Date.now() - startTime
    const clientId = req.client?.id || 'unauthenticated'

    // Do not log health checks — too noisy
    if (req.path === '/health') return

    const logData = {
      requestId,
      method: req.method,
      path: req.path,
      status: res.statusCode,
      duration: duration + 'ms',
      clientId,
      ip: req.ip,
      userAgent: req.headers['user-agent']?.substring(0, 50)
    }

    // Log level based on response status
    if (res.statusCode >= 500) {
      logger.error('Request failed', logData)
    } else if (res.statusCode >= 400) {
      logger.warn('Client error', logData)
    } else {
      logger.info('Request completed', logData)
    }

    // Warn on slow requests
    if (duration > 2000) {
      logger.warn('Slow request detected', { ...logData, threshold: '2000ms' })
    }
  })

  next()
}

module.exports = { requestLogger }
