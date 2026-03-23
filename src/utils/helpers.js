// ============================================================
// src/utils/helpers.js
// Small utility functions used across the codebase
// ============================================================
const crypto = require('crypto')

// ── MASK SENSITIVE DATA ───────────────────────────────────
function maskPhone(phone) {
  if (!phone) return 'unknown'
  return phone.substring(0, 6) + '****' + phone.slice(-2)
}

function maskApiKey(key) {
  if (!key) return 'unknown'
  return key.substring(0, 12) + '...' + key.slice(-4)
}

// ── SAFE JSON PARSE ───────────────────────────────────────
function safeJsonParse(str, fallback = null) {
  try {
    return JSON.parse(str)
  } catch {
    return fallback
  }
}

// ── SLEEP ─────────────────────────────────────────────────
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// ── GENERATE SECURE RANDOM STRING ─────────────────────────
function generateSecureToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex')
}

// ── GENERATE API KEY ──────────────────────────────────────
function generateApiKey() {
  return 'nk_live_' + crypto.randomBytes(24).toString('hex')
}

// ── FORMAT DH AMOUNT ──────────────────────────────────────
function formatDH(amount) {
  return parseFloat(amount).toFixed(2) + ' DH'
}

// ── CHUNK ARRAY ───────────────────────────────────────────
function chunk(array, size) {
  const chunks = []
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size))
  }
  return chunks
}

// ── IS VALID UUID ─────────────────────────────────────────
function isValidUUID(str) {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
  return uuidRegex.test(str)
}

// ── TRUNCATE STRING ───────────────────────────────────────
function truncate(str, length = 50) {
  if (!str) return ''
  return str.length > length ? str.substring(0, length) + '...' : str
}

// ── RETRY FUNCTION ────────────────────────────────────────
async function retry(fn, { attempts = 3, delay = 1000 } = {}) {
  let lastError
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn()
    } catch (err) {
      lastError = err
      if (i < attempts - 1) {
        await sleep(delay * (i + 1))
      }
    }
  }
  throw lastError
}

// ── MOROCCAN PHONE VALIDATOR ──────────────────────────────
function isMoroccanPhone(phone) {
  const cleaned = String(phone).replace(/[\s\-\(\)\.]/g, '')
  return /^(\+212|212|0)[5-7]\d{8}$/.test(cleaned)
}

module.exports = {
  maskPhone,
  maskApiKey,
  safeJsonParse,
  sleep,
  generateSecureToken,
  generateApiKey,
  formatDH,
  chunk,
  isValidUUID,
  truncate,
  retry,
  isMoroccanPhone
}
