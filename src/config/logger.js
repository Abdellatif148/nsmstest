// ============================================================
// src/config/logger.js
// Production logging with Winston
// Logs go to: console (dev) + rotating files (prod)
// Every request, every error, every SMS — logged.
// ============================================================
const winston = require('winston')
require('winston-daily-rotate-file')
const path = require('path')
const config = require('./env')

// ── Formats ──────────────────────────────────────────────────
const productionFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.json()
)

const developmentFormat = winston.format.combine(
  winston.format.colorize(),
  winston.format.timestamp({ format: 'HH:mm:ss' }),
  winston.format.printf(({ timestamp, level, message, ...meta }) => {
    const metaStr = Object.keys(meta).length ? '\n' + JSON.stringify(meta, null, 2) : ''
    return `${timestamp} [${level}] ${message}${metaStr}`
  })
)

// ── Rotating file transports (production only) ───────────────
const fileRotateTransport = new winston.transports.DailyRotateFile({
  dirname:     config.logging.dir,
  filename:    'nook-sms-%DATE%.log',
  datePattern: 'YYYY-MM-DD',
  maxFiles:    '30d',
  maxSize:     '20m',
  format:      productionFormat,
  level:       'info'
})

const errorFileTransport = new winston.transports.DailyRotateFile({
  dirname:     config.logging.dir,
  filename:    'nook-sms-errors-%DATE%.log',
  datePattern: 'YYYY-MM-DD',
  maxFiles:    '90d',
  format:      productionFormat,
  level:       'error'
})

// ── Console transport (always present) ───────────────────────
const consoleTransport = new winston.transports.Console({
  format: config.server.isDev ? developmentFormat : productionFormat,
  level:  config.logging.level
})

// ── Main transports ──────────────────────────────────────────
const transports = [consoleTransport]

if (config.server.isProd) {
  transports.push(fileRotateTransport)
  transports.push(errorFileTransport)
}

// ── Exception / rejection handlers ───────────────────────────
// Must ALWAYS have at least one transport — empty array crashes Winston
const exceptionHandlers = config.server.isProd
  ? [errorFileTransport]
  : [consoleTransport]        // ← dev: log crashes to console

const rejectionHandlers = config.server.isProd
  ? [errorFileTransport]
  : [consoleTransport]        // ← dev: log unhandled promise rejections to console

// ── Create logger ────────────────────────────────────────────
const logger = winston.createLogger({
  level: config.logging.level,
  exitOnError: false,         // let YOUR code decide when to exit, not Winston
  transports,
  exceptionHandlers,
  rejectionHandlers
})

// ── Structured helpers ───────────────────────────────────────
logger.sms = (action, data) => logger.info(`SMS:${action}`, { category: 'sms', ...data })
logger.auth = (action, data) => logger.info(`AUTH:${action}`, { category: 'auth', ...data })
logger.billing = (action, data) => logger.info(`BILLING:${action}`, { category: 'billing', ...data })

module.exports = logger
