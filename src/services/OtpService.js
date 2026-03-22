// ============================================================
// src/services/OtpService.js
// OTP = One-Time Password (verification codes)
// Special rules: shorter expiry, limited retries, auto-generate code
// Used by: banks, apps, e-commerce for phone verification
// ============================================================

const crypto = require('crypto')
const { supabase } = require('../config/database')
const { sendSMS } = require('./SmsService')
const logger = require('../config/logger')

const OTP_EXPIRY_MINUTES = 10
const MAX_ATTEMPTS = 3
const OTP_LENGTH = 6

// ── GENERATE SECURE OTP ───────────────────────────────────
function generateOTP() {
  // Cryptographically secure random 6-digit number
  // Do NOT use Math.random() — it is not secure enough for OTPs
  const bytes = crypto.randomBytes(4)
  const number = bytes.readUInt32BE(0) % 1000000
  return String(number).padStart(OTP_LENGTH, '0')
}

// ── SEND OTP ──────────────────────────────────────────────
async function sendOTP({ to, clientId, client, purpose = 'verification', language = 'fr' }) {

  // Check if there is a recent unused OTP for this number
  // Prevent spam: max 1 OTP per phone per 60 seconds
  const oneMinuteAgo = new Date(Date.now() - 60 * 1000).toISOString()

  const { data: recentOtp } = await supabase
    .from('otps')
    .select('created_at')
    .eq('client_id', clientId)
    .eq('phone', to)
    .eq('used', false)
    .gte('created_at', oneMinuteAgo)
    .single()

  if (recentOtp) {
    return {
      success: false,
      error: 'OTP already sent. Wait 60 seconds before requesting again.',
      code: 'OTP_TOO_FREQUENT',
      retry_after: 60
    }
  }

  const code = generateOTP()
  const expiresAt = new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000).toISOString()
  const otpId = require('uuid').v4()

  // Hash the OTP before storing — never store OTP in plain text
  // Like storing passwords: store the hash, verify the hash
  const codeHash = crypto.createHash('sha256').update(code).digest('hex')

  // Build message based on purpose and language
  const messages = {
    fr: {
      verification: `Votre code de vérification Nook est: ${code}. Valide ${OTP_EXPIRY_MINUTES} minutes. Ne partagez jamais ce code.`,
      login:        `Code de connexion: ${code}. Valide ${OTP_EXPIRY_MINUTES} min. Si vous n'avez pas demandé ce code, ignorez ce message.`,
      payment:      `Code de confirmation paiement: ${code}. Valide ${OTP_EXPIRY_MINUTES} min. Ne partagez JAMAIS ce code.`,
    },
    ar: {
      verification: `رمز التحقق الخاص بك: ${code}. صالح لمدة ${OTP_EXPIRY_MINUTES} دقيقة. لا تشارك هذا الرمز أبداً.`,
      login:        `رمز تسجيل الدخول: ${code}. صالح لمدة ${OTP_EXPIRY_MINUTES} دقيقة.`,
      payment:      `رمز تأكيد الدفع: ${code}. صالح لمدة ${OTP_EXPIRY_MINUTES} دقيقة. لا تشاركه أبداً.`,
    }
  }

  const lang = messages[language] ? language : 'fr'
  const purposeMessages = messages[lang]
  const message = purposeMessages[purpose] || purposeMessages.verification

  // Save OTP record BEFORE sending
  await supabase.from('otps').insert({
    id: otpId,
    client_id: clientId,
    phone: to,
    code_hash: codeHash,
    purpose,
    attempts: 0,
    used: false,
    expires_at: expiresAt,
    created_at: new Date().toISOString()
  })

  // Send the SMS
  try {
    const result = await sendSMS({
      to,
      message,
      clientId,
      client,
      messageType: 'otp'
    })

    logger.sms('OTP_SENT', { otpId, phone: to.substring(0, 8) + '***', purpose })

    return {
      success: true,
      otp_id: otpId,
      expires_in: OTP_EXPIRY_MINUTES * 60,  // seconds
      expires_at: expiresAt,
      message_id: result.message_id,
      // NEVER return the code in the response
      // The whole point is the user receives it on their phone
    }

  } catch (sendErr) {
    // Delete OTP record if send failed
    await supabase.from('otps').delete().eq('id', otpId)
    throw sendErr
  }
}

// ── VERIFY OTP ────────────────────────────────────────────
async function verifyOTP({ otpId, phone, code, clientId }) {

  const { data: otp, error } = await supabase
    .from('otps')
    .select('*')
    .eq('id', otpId)
    .eq('client_id', clientId)
    .single()

  if (error || !otp) {
    return { valid: false, error: 'OTP not found', code: 'OTP_NOT_FOUND' }
  }

  // Check phone matches
  if (otp.phone !== phone) {
    return { valid: false, error: 'Phone number mismatch', code: 'PHONE_MISMATCH' }
  }

  // Check if already used
  if (otp.used) {
    return { valid: false, error: 'OTP already used', code: 'OTP_USED' }
  }

  // Check expiry
  if (new Date() > new Date(otp.expires_at)) {
    return { valid: false, error: 'OTP expired', code: 'OTP_EXPIRED' }
  }

  // Check attempts
  if (otp.attempts >= MAX_ATTEMPTS) {
    return { valid: false, error: 'Too many failed attempts', code: 'OTP_MAX_ATTEMPTS' }
  }

  // Verify the code by comparing hashes
  const inputHash = crypto.createHash('sha256').update(code).digest('hex')

  if (inputHash !== otp.code_hash) {
    // Increment attempts
    await supabase
      .from('otps')
      .update({ attempts: otp.attempts + 1 })
      .eq('id', otpId)

    const attemptsLeft = MAX_ATTEMPTS - otp.attempts - 1
    logger.sms('OTP_WRONG_CODE', { otpId, attemptsLeft })

    return {
      valid: false,
      error: 'Invalid code',
      code: 'INVALID_OTP',
      attempts_remaining: attemptsLeft
    }
  }

  // ✅ Valid! Mark as used
  await supabase
    .from('otps')
    .update({ used: true, used_at: new Date().toISOString() })
    .eq('id', otpId)

  logger.sms('OTP_VERIFIED', { otpId, purpose: otp.purpose })

  return {
    valid: true,
    purpose: otp.purpose,
    verified_at: new Date().toISOString()
  }
}

// ── CLEANUP EXPIRED OTPs ──────────────────────────────────
// Called by cron job every hour
async function cleanupExpiredOtps() {
  const { count } = await supabase
    .from('otps')
    .delete()
    .lt('expires_at', new Date().toISOString())
    .select('*', { count: 'exact', head: true })

  logger.info('OTP cleanup complete', { deleted: count })
  return count
}

module.exports = { sendOTP, verifyOTP, cleanupExpiredOtps }
