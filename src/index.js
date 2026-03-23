/**
 * Nook SMS API — Production v2.0
 * Main entry point
 */
require('dotenv').config()
const express = require('express')
const helmet = require('helmet')
const cors = require('cors')
const compression = require('compression')
const morgan = require('morgan')
const { testConnection } = require('./config/database')
const { startCrons } = require('./crons')
const logger = require('./config/logger')

const app = express()
const PORT = process.env.PORT || 3000

// ─── SECURITY MIDDLEWARE ──────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false
}))

app.use(cors({
  origin: (process.env.ALLOWED_ORIGINS || 'http://localhost:3001').split(',').map(o => o.trim()),
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Authorization', 'Content-Type', 'X-Admin-Key', 'X-Nook-Sandbox', 'X-Webhook-Signature'],
  credentials: true
}))

app.use(compression())
app.use(express.json({ limit: '10mb' }))
app.use(express.urlencoded({ extended: true, limit: '10mb' }))

// ─── LOGGING ─────────────────────────────────────────────────
if (process.env.NODE_ENV !== 'test') {
  app.use(morgan('combined', {
    stream: { write: msg => logger.info(msg.trim()) },
    skip: (req) => req.path === '/health'
  }))
}

// ─── HEALTH CHECK ─────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'Nook SMS API',
    version: '2.0.0',
    environment: process.env.NODE_ENV || 'development',
    uptime: process.uptime().toFixed(2),
    timestamp: new Date().toISOString(),
    memory: `${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`
  })
})

// ─── ROUTES ───────────────────────────────────────────────────
// Auth
app.use('/v1/auth', require('./routes/auth'))

// SMS Core
app.use('/v1/sms', require('./routes/sms'))

// OTP
app.use('/v1/otp', require('./routes/otp'))

// Analytics
app.use('/v1/analytics', require('./routes/analytics'))

// Client account
app.use('/v1/clients', require('./routes/clients'))

// Templates
app.use('/v1/templates', require('./routes/templates'))

// Contact Lists
app.use('/v1/contacts', require('./routes/contacts'))

// Scheduled Messages
app.use('/v1/scheduled', require('./routes/scheduled'))

// Advanced Features
const { lookupRouter, linksRouter, redirectRouter, senderRouter } = require('./routes/advanced')
app.use('/v1/lookup', lookupRouter)
app.use('/v1/links', linksRouter)
app.use('/v1/sender-ids', senderRouter)

// Short link redirects (public, no auth)
app.use('/r', redirectRouter)

// Reseller
app.use('/v1/reseller', require('./routes/reseller'))

// Admin
app.use('/v1/admin', require('./routes/admin'))

// ─── SANDBOX MODE MIDDLEWARE ──────────────────────────────────
app.use('/sandbox/*', (req, res, next) => {
  req.sandboxMode = true
  next()
})
app.use('/sandbox/v1', (req, res, next) => {
  // Rewrite to normal routes but with sandbox flag
  req.url = req.url.replace('/sandbox', '')
  req.sandboxMode = true
  next()
})

// ─── 404 HANDLER ─────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({
    error: 'Endpoint not found',
    code: 'NOT_FOUND',
    path: req.path,
    docs: 'https://dashboard.nook.ma/docs'
  })
})

// ─── GLOBAL ERROR HANDLER ────────────────────────────────────
app.use((err, req, res, next) => {
  logger.error('Unhandled error:', {
    error: err.message,
    stack: err.stack,
    path: req.path,
    method: req.method
  })

  if (res.headersSent) return next(err)

  res.status(err.status || 500).json({
    error: process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message,
    code: err.code || 'SERVER_ERROR',
    ...(process.env.NODE_ENV !== 'production' && { stack: err.stack })
  })
})

// ─── START SERVER ─────────────────────────────────────────────
async function start() {
  try {
    await testConnection()
    logger.info('✓ Database connected')

    app.listen(PORT, () => {
      logger.info(`✓ Nook SMS API v2.0 running on port ${PORT}`)
      logger.info(`  Environment: ${process.env.NODE_ENV || 'development'}`)
      logger.info(`  Docs: https://dashboard.nook.ma/docs`)
    })

    if (process.env.NODE_ENV !== 'test') {
      startCrons()
    }

    // Graceful shutdown
    process.on('SIGTERM', () => {
      logger.info('SIGTERM received, shutting down...')
      process.exit(0)
    })

    process.on('uncaughtException', (err) => {
      logger.error('Uncaught exception:', err)
      process.exit(1)
    })

    process.on('unhandledRejection', (reason) => {
      logger.error('Unhandled rejection:', reason)
    })
  } catch (err) {
    logger.error('Failed to start server:', err)
    process.exit(1)
  }
}

start()

module.exports = app
