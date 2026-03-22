// ============================================================
// src/routes/clients.js — Client account management
// ============================================================

const express = require('express')
const router = express.Router()
const { v4: uuidv4 } = require('uuid')
const crypto = require('crypto')
const { authenticateApiKey, invalidateClientCache } = require('../middleware/auth')
const { validate } = require('../middleware/validate')
const { supabase } = require('../config/database')
const logger = require('../config/logger')

// ── POST /register — Public endpoint ─────────────────────
router.post('/register', validate('registerClient'), async (req, res) => {
  try {
    const { company_name, email, phone, plan, webhook_url } = req.body

    // Check existing email
    const { data: existing } = await supabase
      .from('clients')
      .select('id')
      .eq('email', email)
      .single()

    if (existing) {
      return res.status(409).json({
        error: 'Email already registered',
        code: 'EMAIL_EXISTS',
        message: 'Use a different email or reset your API key at nook.ma/account'
      })
    }

    // Generate API key — cryptographically secure
    const apiKey = 'nk_live_' + crypto.randomBytes(24).toString('hex')

    const client = {
      id: uuidv4(),
      name: company_name,
      email,
      phone,
      plan: plan || 'basic',
      api_key: apiKey,
      status: 'active',
      credits: 50.00,  // 50 DH free credits
      default_sender_id: 'NOOK',
      webhook_url: webhook_url || null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    }

    const { error } = await supabase.from('clients').insert(client)

    if (error) {
      logger.error('Client registration failed', { error: error.message })
      return res.status(500).json({ error: 'Registration failed', code: 'REGISTRATION_FAILED' })
    }

    // Record initial credit grant
    await supabase.from('billing_transactions').insert({
      client_id: client.id,
      type: 'bonus',
      amount: 50.00,
      balance_before: 0,
      balance_after: 50.00,
      description: 'Welcome bonus — 50 DH free credits'
    })

    logger.auth('REGISTERED', { clientId: client.id, email, plan })

    return res.status(201).json({
      success: true,
      client_id: client.id,
      api_key: apiKey,  // Shown ONCE only
      plan: client.plan,
      starting_credits: '50 DH',
      warning: '⚠️  SAVE YOUR API KEY NOW. For security, it cannot be shown again.',
      quickstart: {
        send_sms: `curl -X POST https://api.nook.ma/v1/sms/send -H "Authorization: Bearer ${apiKey.substring(0, 20)}..." -d '{"to":"+212600000000","message":"Hello"}'`,
        docs: 'https://docs.nook.ma',
        support: 'dev@nook.ma'
      }
    })

  } catch (err) {
    logger.error('Registration error', { error: err.message })
    return res.status(500).json({ error: 'Internal server error' })
  }
})

// ── Protected routes — require API key ───────────────────
router.use(authenticateApiKey)

// ── GET /me ───────────────────────────────────────────────
router.get('/me', async (req, res) => {
  const client = req.client

  // Get this month's usage
  const monthStart = new Date()
  monthStart.setDate(1)
  monthStart.setHours(0,0,0,0)

  const { count: monthlyCount } = await supabase
    .from('messages')
    .select('*', { count: 'exact', head: true })
    .eq('client_id', client.id)
    .gte('created_at', monthStart.toISOString())

  const planLimits = {
    basic: { messages_per_second: 10, monthly_messages: 10000 },
    standard: { messages_per_second: 50, monthly_messages: 100000 },
    enterprise: { messages_per_second: 200, monthly_messages: 'unlimited' }
  }

  return res.json({
    id: client.id,
    name: client.name,
    email: client.email,
    phone: client.phone,
    plan: client.plan,
    status: client.status,
    credits: {
      amount: client.credits,
      currency: 'DH',
      recharge_url: 'https://nook.ma/billing'
    },
    this_month: {
      messages_sent: monthlyCount || 0,
      limit: planLimits[client.plan]?.monthly_messages || 10000
    },
    plan_limits: planLimits[client.plan],
    webhook_url: client.webhook_url,
    default_sender_id: client.default_sender_id,
    created_at: client.created_at
  })
})

// ── PATCH /me — Update account ───────────────────────────
router.patch('/me', validate('updateClient'), async (req, res) => {
  try {
    const updates = {
      ...req.body,
      updated_at: new Date().toISOString()
    }

    // Map to database column names
    if (updates.company_name) {
      updates.name = updates.company_name
      delete updates.company_name
    }
    if (updates.default_sender_id !== undefined) {
      updates.default_sender_id = updates.default_sender_id
    }

    const { data, error } = await supabase
      .from('clients')
      .update(updates)
      .eq('id', req.client.id)
      .select()
      .single()

    if (error) throw error

    // Invalidate cache so next request gets fresh data
    invalidateClientCache(req.client.api_key)

    return res.json({
      success: true,
      message: 'Account updated',
      updated: Object.keys(req.body)
    })

  } catch (err) {
    logger.error('Update client error', { error: err.message })
    return res.status(500).json({ error: 'Failed to update account' })
  }
})

// ── POST /rotate-key — Rotate API key ────────────────────
router.post('/rotate-key', async (req, res) => {
  try {
    const oldKey = req.client.api_key
    const newKey = 'nk_live_' + crypto.randomBytes(24).toString('hex')

    await supabase
      .from('clients')
      .update({ api_key: newKey, updated_at: new Date().toISOString() })
      .eq('id', req.client.id)

    // Log rotation for audit
    await supabase.from('api_key_rotations').insert({
      client_id: req.client.id,
      old_key_hash: crypto.createHash('sha256').update(oldKey).digest('hex'),
      new_key_hash: crypto.createHash('sha256').update(newKey).digest('hex'),
      ip_address: req.ip,
      rotated_by: 'client'
    })

    // Invalidate old key from cache
    invalidateClientCache(oldKey)

    logger.auth('KEY_ROTATED', { clientId: req.client.id, ip: req.ip })

    return res.json({
      success: true,
      new_api_key: newKey,
      warning: '⚠️  Your old API key is now invalid. Update your applications immediately.',
      effective_immediately: true
    })

  } catch (err) {
    return res.status(500).json({ error: 'Failed to rotate API key' })
  }
})

// ── GET /billing ──────────────────────────────────────────
router.get('/billing', async (req, res) => {
  try {
    const { data: transactions } = await supabase
      .from('billing_transactions')
      .select('*')
      .eq('client_id', req.client.id)
      .order('created_at', { ascending: false })
      .limit(50)

    return res.json({
      current_balance: req.client.credits,
      currency: 'DH',
      transactions: transactions || []
    })

  } catch (err) {
    return res.status(500).json({ error: 'Failed to get billing data' })
  }
})

module.exports = router
