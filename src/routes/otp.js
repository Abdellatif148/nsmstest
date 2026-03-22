// ============================================================
// src/routes/otp.js
// OTP endpoints — for businesses needing phone verification
// Banks, e-commerce, apps all use this
// ============================================================

const express = require('express')
const router = express.Router()
const { authenticateApiKey } = require('../middleware/auth')
const { planRateLimit } = require('../middleware/planRateLimit')
const { sendOTP, verifyOTP } = require('../services/OtpService')
const Joi = require('joi')

router.use(authenticateApiKey)
router.use(planRateLimit)

const moroccanPhone = Joi.string()
  .pattern(/^(\+212|212|0)[5-7]\d{8}$/)
  .message('Must be a valid Moroccan phone number')

// ── POST /otp/send ────────────────────────────────────────
// Business requests OTP for their customer's phone
// Request: { "to": "+212612345678", "purpose": "login" }
// Response: { "otp_id": "uuid", "expires_in": 600 }
router.post('/send', async (req, res) => {
  try {
    const { error: valErr, value } = Joi.object({
      to: moroccanPhone.required(),
      purpose: Joi.string().valid('verification', 'login', 'payment').default('verification'),
      language: Joi.string().valid('fr', 'ar').default('fr')
    }).validate(req.body, { stripUnknown: true })

    if (valErr) {
      return res.status(400).json({
        error: 'Validation failed',
        code: 'VALIDATION_ERROR',
        detail: valErr.details[0].message
      })
    }

    const result = await sendOTP({
      to: value.to,
      clientId: req.client.id,
      client: req.client,
      purpose: value.purpose,
      language: value.language
    })

    if (!result.success) {
      return res.status(429).json(result)
    }

    return res.status(200).json(result)

  } catch (err) {
    return res.status(500).json({ error: 'Failed to send OTP', code: 'OTP_SEND_FAILED' })
  }
})

// ── POST /otp/verify ──────────────────────────────────────
// Business verifies the code their customer entered
// Request: { "otp_id": "uuid", "phone": "+212...", "code": "482910" }
// Response: { "valid": true, "purpose": "login" }
router.post('/verify', async (req, res) => {
  try {
    const { error: valErr, value } = Joi.object({
      otp_id: Joi.string().uuid().required(),
      phone: moroccanPhone.required(),
      code: Joi.string().length(6).pattern(/^\d{6}$/).required()
    }).validate(req.body, { stripUnknown: true })

    if (valErr) {
      return res.status(400).json({
        error: 'Validation failed',
        detail: valErr.details[0].message
      })
    }

    const result = await verifyOTP({
      otpId: value.otp_id,
      phone: value.phone,
      code: value.code,
      clientId: req.client.id
    })

    // Return appropriate status code
    const statusCode = result.valid ? 200 : 400
    return res.status(statusCode).json(result)

  } catch (err) {
    return res.status(500).json({ error: 'OTP verification failed' })
  }
})

module.exports = router
