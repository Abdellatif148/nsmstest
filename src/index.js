// ============================================================
// src/index.js — Production application entry point
// This is what starts everything
// ============================================================

// Load environment FIRST before anything else
require('dotenv').config()
const config = require('./config/env')  // Validates env or crashes
const logger = require('./config/logger')

const express = require('express')
const helmet = require('helmet')
const cors = require('cors')
const compression = require('compression')
const morgan = require('morgan')
const rateLimit = require('express-rate-limit')
const { testConnection } = require('./config/database')

// ── CREATE APP ────────────────────────────────────────────
const app = express()

// ── TRUST PROXY ───────────────────────────────────────────
// Required when behind Railway/Render/Nginx proxy
// Allows req.ip to show real client IP
app.set('trust proxy', 1)

// ── SECURITY HEADERS ─────────────────────────────────────
// Helmet sets 11 security-related HTTP headers automatically
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"]
    }
  }
}))

// ── CORS ──────────────────────────────────────────────────
app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (mobile apps, curl, Postman)
    if (!origin) return callback(null, true)

    if (config.cors.origins.includes(origin) || config.server.isDev) {
      callback(null, true)
    } else {
      callback(new Error(`CORS: Origin ${origin} not allowed`))
    }
  },
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Admin-Key'],
  credentials: true
}))

// ── COMPRESSION ───────────────────────────────────────────
// Compress all responses — reduces bandwidth by 60-80%
app.use(compression())

// ── BODY PARSING ──────────────────────────────────────────
app.use(express.json({ limit: '10mb' }))  // Limit prevents memory attacks
app.use(express.urlencoded({ extended: true, limit: '10mb' }))

// ── HTTP REQUEST LOGGING ─────────────────────────────────
// Morgan logs every HTTP request
const morganFormat = config.server.isDev ? 'dev' : 'combined'
app.use(morgan(morganFormat, {
  stream: {
    write: (message) => logger.info(message.trim(), { category: 'http' })
  },
  skip: (req) => req.path === '/health'  // Don't log health checks
}))

// ── GLOBAL RATE LIMIT ─────────────────────────────────────
const globalLimit = rateLimit({
  windowMs: config.rateLimit.windowMs,
  max: config.rateLimit.max,
  standardHeaders: true,   // Send RateLimit-* headers
  legacyHeaders: false,
  handler: (req, res) => {
    logger.warn('Rate limit exceeded', { ip: req.ip, path: req.path })
    res.status(429).json({
      error: 'Too many requests',
      code: 'RATE_LIMIT_EXCEEDED',
      retry_after: Math.ceil(config.rateLimit.windowMs / 1000) + ' seconds'
    })
  }
})
app.use(globalLimit)

// ── REQUEST LOGGER ───────────────────────────────────────
const { requestLogger } = require('./middleware/requestLogger')
app.use(requestLogger)

// ── ROUTES ───────────────────────────────────────────────
const version = config.server.version

app.use(`/${version}/sms`, require('./routes/sms'))
app.use(`/${version}/otp`, require('./routes/otp'))
app.use(`/${version}/analytics`, require('./routes/analytics'))
app.use(`/${version}/clients`, require('./routes/clients'))

// Admin routes — only accessible with X-Admin-Key header
// Bind to internal path so reverse proxy can block external access
app.use(`/${version}/admin`, require('./routes/admin'))

// ── START CRON JOBS ───────────────────────────────────────
if (config.server.isProd) {
  require('./crons')  // Starts all scheduled jobs
}

// ── HEALTH CHECK ─────────────────────────────────────────
app.get('/health', async (req, res) => {
  const { checkGatewayHealth } = require('./services/GatewayService')

  try {
    const gatewayHealth = await checkGatewayHealth()

    res.json({
      status: 'ok',
      service: 'Nook SMS API',
      version: '1.0.0',
      environment: config.server.env,
      timestamp: new Date().toISOString(),
      gateways: gatewayHealth,
      uptime: process.uptime() + ' seconds'
    })
  } catch {
    res.json({
      status: 'ok',
      service: 'Nook SMS API',
      timestamp: new Date().toISOString()
    })
  }
})

// ── API INFO ─────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    name: 'Nook SMS API',
    description: "Morocco's production-grade SMS infrastructure",
    version: '1.0.0',
    documentation: 'https://docs.nook.ma',
    endpoints: {
      register: `POST /${version}/clients/register`,
      send: `POST /${version}/sms/send`,
      bulk: `POST /${version}/sms/bulk`,
      status: `GET /${version}/sms/status/:messageId`,
      analytics: `GET /${version}/analytics/overview`,
      account: `GET /${version}/clients/me`
    }
  })
})

// ── 404 HANDLER ───────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({
    error: 'Endpoint not found',
    code: 'NOT_FOUND',
    path: req.path,
    docs: 'https://docs.nook.ma'
  })
})

// ── GLOBAL ERROR HANDLER ──────────────────────────────────
app.use((err, req, res, next) => {
  // CORS error
  if (err.message?.includes('CORS')) {
    return res.status(403).json({
      error: 'CORS policy violation',
      code: 'CORS_ERROR'
    })
  }

  logger.error('Unhandled error', {
    error: err.message,
    stack: config.server.isDev ? err.stack : undefined,
    path: req.path,
    method: req.method
  })

  res.status(500).json({
    error: 'Internal server error',
    code: 'SERVER_ERROR',
    ...(config.server.isDev && { detail: err.message })
  })
})

// ── GRACEFUL SHUTDOWN ─────────────────────────────────────
process.on('SIGTERM', () => {
  logger.info('SIGTERM received — shutting down gracefully')
  server.close(() => {
    logger.info('Server closed')
    process.exit(0)
  })
})

process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception', { error: err.message, stack: err.stack })
  process.exit(1)
})

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection', { reason })
})

// ── START SERVER ─────────────────────────────────────────
async function start() {
  // Test database connection before accepting traffic
  await testConnection()

  const server = app.listen(config.server.port, () => {
    logger.info(`
╔═══════════════════════════════════════════════╗
║          NOOK SMS API — PRODUCTION            ║
║   http://localhost:${config.server.port}                    ║
║   Environment: ${config.server.env.padEnd(29)}║
║   Version: ${config.server.version.padEnd(34)}║
╚═══════════════════════════════════════════════╝`)
  })

  return server
}

start().catch(err => {
  logger.error('Failed to start server', { error: err.message })
  process.exit(1)
})

module.exports = app
