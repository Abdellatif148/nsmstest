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

// Custom log format — structured JSON for production
// Human readable for development
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

// Rotating file transport — new file each day, keeps 30 days
const fileRotateTransport = new winston.transports.DailyRotateFile({
  dirname: config.logging.dir,
  filename: 'nook-sms-%DATE%.log',
  datePattern: 'YYYY-MM-DD',
  maxFiles: '30d',       // Keep 30 days
  maxSize: '20m',        // Max 20MB per file
  format: productionFormat,
  level: 'info'
})

// Error-only file for quick error monitoring
const errorFileTransport = new winston.transports.DailyRotateFile({
  dirname: config.logging.dir,
  filename: 'nook-sms-errors-%DATE%.log',
  datePattern: 'YYYY-MM-DD',
  maxFiles: '90d',       // Keep errors for 90 days
  format: productionFormat,
  level: 'error'
})

const transports = [
  // Always log to console
  new winston.transports.Console({
    format: config.server.isDev ? developmentFormat : productionFormat,
    level: config.logging.level
  })
]

// Add file logging in production
if (config.server.isProd) {
  transports.push(fileRotateTransport)
  transports.push(errorFileTransport)
}

const logger = winston.createLogger({
  level: config.logging.level,
  transports,
  // Don't crash on uncaught exceptions
  exceptionHandlers: config.server.isProd ? [errorFileTransport] : [],
  rejectionHandlers: config.server.isProd ? [errorFileTransport] : [],
})

// Helper methods for structured logging
logger.sms = (action, data) => {
  logger.info(`SMS:${action}`, {
    category: 'sms',
    ...data
  })
}

logger.auth = (action, data) => {
  logger.info(`AUTH:${action}`, {
    category: 'auth',
    ...data
  })
}

logger.billing = (action, data) => {
  logger.info(`BILLING:${action}`, {
    category: 'billing',
    ...data
  })
}

module.exports = logger
