/**
 * auth.js — Authentication routes
 * POST /v1/auth/register
 * POST /v1/auth/login
 * POST /v1/auth/forgot-password
 * POST /v1/auth/reset-password
 * POST /v1/auth/refresh
 */
const express = require('express')
const router = express.Router()
const bcrypt = require('bcryptjs')
const jwt = require('jsonwebtoken')
const crypto = require('node:crypto')
const Joi = require('joi')
const { supabase } = require('../config/database')
const EmailService = require('../services/EmailService')
const logger = require('../config/logger')
const { generateApiKey } = require('../utils/helpers')

const JWT_SECRET = process.env.JWT_SECRET
const JWT_EXPIRES = '7d'
const REFRESH_EXPIRES = '30d'

// ─── REGISTER ───────────────────────────────────────────────
router.post('/register', async (req, res) => {
  const schema = Joi.object({
    company_name: Joi.string().min(2).max(100).required(),
    email: Joi.string().email().required(),
    phone: Joi.string().pattern(/^(\+212|212|0)[5-7]\d{8}$/).required(),
    password: Joi.string().min(8).required(),
    plan: Joi.string().valid('basic', 'standard', 'enterprise').default('basic')
  })
  const { error, value } = schema.validate(req.body)
  if (error) return res.status(400).json({ error: error.details[0].message, code: 'VALIDATION_ERROR' })

  try {
    // Check duplicate email
    const { data: existing } = await supabase
      .from('clients')
      .select('id')
      .eq('email', value.email)
      .single()

    if (existing) return res.status(409).json({ error: 'Email already registered', code: 'EMAIL_EXISTS' })

    const apiKey = generateApiKey()
    const passwordHash = await bcrypt.hash(value.password, 12)

    const { data: client, error: insertErr } = await supabase
      .from('clients')
      .insert({
        name: value.company_name,
        email: value.email,
        phone: value.phone,
        password_hash: passwordHash,
        api_key: apiKey,
        plan: value.plan,
        status: 'active',
        rate_limit: value.plan === 'basic' ? 10 : value.plan === 'standard' ? 50 : 200
      })
      .select()
      .single()

    if (insertErr) throw insertErr

    // Add initial credits based on plan
    const initialCredits = { basic: 20, standard: 50, enterprise: 100 }[value.plan]
    await supabase.from('billing_transactions').insert({
      client_id: client.id,
      type: 'credit',
      amount: initialCredits,
      balance_before: 0,
      balance_after: initialCredits,
      description: `Crédits de bienvenue — Plan ${value.plan}`,
      payment_reference: 'WELCOME'
    })

    // Send welcome email
    try {
      await EmailService.sendWelcome({
        name: client.name,
        email: client.email,
        api_key: apiKey,
        plan: client.plan,
        credits: initialCredits
      })
    } catch (emailErr) {
      logger.warn('Welcome email failed:', emailErr.message)
    }

    const token = jwt.sign({ id: client.id, role: 'client' }, JWT_SECRET, { expiresIn: JWT_EXPIRES })
    const refreshToken = jwt.sign({ id: client.id, type: 'refresh' }, JWT_SECRET, { expiresIn: REFRESH_EXPIRES })

    logger.info(`New client registered: ${client.email} (${value.plan})`)

    return res.status(201).json({
      success: true,
      message: 'Account created. Check your email for your API key.',
      token,
      refresh_token: refreshToken,
      client: {
        id: client.id,
        name: client.name,
        email: client.email,
        plan: client.plan,
        api_key: apiKey,
        credits: initialCredits
      }
    })
  } catch (err) {
    logger.error('Register error:', err)
    return res.status(500).json({ error: 'Registration failed', code: 'REGISTER_FAILED' })
  }
})

// ─── LOGIN ───────────────────────────────────────────────────
router.post('/login', async (req, res) => {
  const schema = Joi.object({
    email: Joi.string().email().required(),
    password: Joi.string().required()
  })
  const { error, value } = schema.validate(req.body)
  if (error) return res.status(400).json({ error: error.details[0].message })

  try {
    const { data: client } = await supabase
      .from('clients')
      .select('*, billing(amount)')
      .eq('email', value.email)
      .single()

    if (!client) return res.status(401).json({ error: 'Invalid credentials', code: 'INVALID_CREDENTIALS' })
    if (client.status === 'suspended') return res.status(403).json({ error: 'Account suspended', code: 'ACCOUNT_SUSPENDED' })

    const valid = await bcrypt.compare(value.password, client.password_hash || '')
    if (!valid) return res.status(401).json({ error: 'Invalid credentials', code: 'INVALID_CREDENTIALS' })

    // Update last login
    await supabase.from('clients').update({ last_login_at: new Date().toISOString() }).eq('id', client.id)

    const token = jwt.sign({ id: client.id, role: 'client' }, JWT_SECRET, { expiresIn: JWT_EXPIRES })
    const refreshToken = jwt.sign({ id: client.id, type: 'refresh' }, JWT_SECRET, { expiresIn: REFRESH_EXPIRES })

    // Calculate current credits
    const { data: billing } = await supabase
      .from('billing_transactions')
      .select('amount, type')
      .eq('client_id', client.id)
    const credits = (billing || []).reduce((s, b) => b.type === 'credit' ? s + b.amount : s - b.amount, 0)

    logger.info(`Login: ${client.email}`)

    return res.json({
      success: true,
      token,
      refresh_token: refreshToken,
      client: {
        id: client.id,
        name: client.name,
        email: client.email,
        plan: client.plan,
        api_key: client.api_key,
        credits: Math.max(0, credits),
        role: client.role || 'client'
      }
    })
  } catch (err) {
    logger.error('Login error:', err)
    return res.status(500).json({ error: 'Login failed' })
  }
})

// ─── FORGOT PASSWORD ─────────────────────────────────────────
router.post('/forgot-password', async (req, res) => {
  const { email } = req.body
  if (!email) return res.status(400).json({ error: 'Email required' })

  try {
    const { data: client } = await supabase
      .from('clients')
      .select('id, name, email')
      .eq('email', email)
      .single()

    // Always return success to prevent email enumeration
    if (!client) return res.json({ success: true, message: 'If this email exists, a reset link has been sent.' })

    const resetToken = crypto.randomBytes(32).toString('hex')
    const expiresAt = new Date(Date.now() + 3600000).toISOString() // 1 hour

    await supabase.from('password_resets').upsert({
      client_id: client.id,
      token: resetToken,
      expires_at: expiresAt
    })

    await EmailService.sendPasswordReset(client, resetToken)

    return res.json({ success: true, message: 'If this email exists, a reset link has been sent.' })
  } catch (err) {
    logger.error('Forgot password error:', err)
    return res.status(500).json({ error: 'Failed to process request' })
  }
})

// ─── RESET PASSWORD ──────────────────────────────────────────
router.post('/reset-password', async (req, res) => {
  const { token, password } = req.body
  if (!token || !password || password.length < 8) {
    return res.status(400).json({ error: 'Valid token and password (min 8 chars) required' })
  }

  try {
    const { data: reset } = await supabase
      .from('password_resets')
      .select('*')
      .eq('token', token)
      .gt('expires_at', new Date().toISOString())
      .single()

    if (!reset) return res.status(400).json({ error: 'Invalid or expired reset token', code: 'INVALID_TOKEN' })

    const passwordHash = await bcrypt.hash(password, 12)
    await supabase.from('clients').update({ password_hash: passwordHash }).eq('id', reset.client_id)
    await supabase.from('password_resets').delete().eq('token', token)

    return res.json({ success: true, message: 'Password updated successfully' })
  } catch (err) {
    logger.error('Reset password error:', err)
    return res.status(500).json({ error: 'Failed to reset password' })
  }
})

// ─── REFRESH TOKEN ───────────────────────────────────────────
router.post('/refresh', async (req, res) => {
  const { refresh_token } = req.body
  if (!refresh_token) return res.status(400).json({ error: 'Refresh token required' })

  try {
    const decoded = jwt.verify(refresh_token, JWT_SECRET)
    if (decoded.type !== 'refresh') throw new Error('Invalid token type')

    const { data: client } = await supabase.from('clients').select('id, status').eq('id', decoded.id).single()
    if (!client || client.status === 'suspended') throw new Error('Account not active')

    const token = jwt.sign({ id: client.id, role: 'client' }, JWT_SECRET, { expiresIn: JWT_EXPIRES })
    return res.json({ success: true, token })
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired refresh token' })
  }
})

// ─── VERIFY TOKEN ────────────────────────────────────────────
router.get('/verify', async (req, res) => {
  const authHeader = req.headers.authorization
  if (!authHeader) return res.status(401).json({ valid: false })

  try {
    const token = authHeader.replace('Bearer ', '')
    // Could be JWT or API key
    if (token.startsWith('nk_')) {
      const { data: client } = await supabase.from('clients').select('id, status, plan').eq('api_key', token).single()
      if (!client || client.status !== 'active') return res.status(401).json({ valid: false })
      return res.json({ valid: true, type: 'api_key', plan: client.plan })
    }
    const decoded = jwt.verify(token, JWT_SECRET)
    return res.json({ valid: true, type: 'jwt', client_id: decoded.id })
  } catch (err) {
    return res.status(401).json({ valid: false })
  }
})

module.exports = router
