/**
 * reseller.js — White-label Reseller System
 *
 * HOW IT WORKS:
 * Resellers buy SMS at 0.15 DH (wholesale)
 * They sell to their clients at any price
 * They manage their clients' credits
 * They get their own dashboard
 *
 * POST /v1/reseller/apply          — Apply to become reseller
 * GET  /v1/reseller/dashboard      — Reseller overview
 * POST /v1/reseller/clients        — Create sub-client
 * GET  /v1/reseller/clients        — List sub-clients
 * POST /v1/reseller/clients/:id/credits — Add credits to sub-client
 * GET  /v1/reseller/earnings       — Commission history
 * GET  /v1/reseller/pricing        — Current wholesale pricing
 */
const express = require('express')
const router = express.Router()
const { supabase } = require('../config/database')
const { authenticateApiKey: authenticate } = require('../middleware/auth')
const EmailService = require('../services/EmailService')
const { generateApiKey } = require('../utils/helpers')
const bcrypt = require('bcryptjs')
const logger = require('../config/logger')

router.use(authenticate)

const WHOLESALE_PRICE = 0.15 // DH per SMS for resellers
const RETAIL_PRICE = 0.20    // Standard retail price

// ─── APPLY TO BECOME RESELLER ────────────────────────────────
router.post('/apply', async (req, res) => {
  const { company_name, website, monthly_volume, use_case } = req.body

  const { data: existing } = await supabase
    .from('resellers')
    .select('id')
    .eq('client_id', req.client.id)
    .single()

  if (existing) return res.status(409).json({ error: 'Already applied or approved as reseller' })

  const { data, error } = await supabase
    .from('resellers')
    .insert({
      client_id: req.client.id,
      company_name,
      website,
      monthly_volume,
      use_case,
      status: 'pending',
      wholesale_price: WHOLESALE_PRICE
    })
    .select().single()

  if (error) return res.status(500).json({ error: error.message })

  logger.info(`Reseller application from client ${req.client.id}`)
  return res.status(201).json({
    success: true,
    message: 'Application submitted. We will review within 2 business days.',
    application: data
  })
})

// ─── DASHBOARD ────────────────────────────────────────────────
router.get('/dashboard', async (req, res) => {
  const { data: reseller } = await supabase
    .from('resellers')
    .select('*')
    .eq('client_id', req.client.id)
    .single()

  if (!reseller || reseller.status !== 'approved') {
    return res.status(403).json({ error: 'Reseller account required', code: 'NOT_RESELLER' })
  }

  const { data: subClients } = await supabase
    .from('clients')
    .select('id, name, email, plan, status, created_at')
    .eq('reseller_id', reseller.id)

  // Total sub-client messages this month
  const startOfMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString()
  const { count: totalMessages } = await supabase
    .from('messages')
    .select('id', { count: 'exact' })
    .in('client_id', (subClients || []).map(c => c.id))
    .gte('created_at', startOfMonth)

  // Earnings: (retail - wholesale) * messages sent by sub-clients
  const margin = RETAIL_PRICE - reseller.wholesale_price
  const estimatedEarnings = (totalMessages || 0) * margin

  return res.json({
    reseller,
    summary: {
      total_sub_clients: (subClients || []).length,
      active_sub_clients: (subClients || []).filter(c => c.status === 'active').length,
      messages_this_month: totalMessages || 0,
      estimated_earnings_dh: parseFloat(estimatedEarnings.toFixed(2)),
      wholesale_price: reseller.wholesale_price,
      retail_price: RETAIL_PRICE,
      margin_per_sms: margin
    },
    sub_clients: subClients || []
  })
})

// ─── CREATE SUB-CLIENT ────────────────────────────────────────
router.post('/clients', async (req, res) => {
  const { data: reseller } = await supabase
    .from('resellers')
    .select('id, status')
    .eq('client_id', req.client.id)
    .single()

  if (!reseller || reseller.status !== 'approved') {
    return res.status(403).json({ error: 'Approved reseller account required' })
  }

  const { company_name, email, phone, plan, initial_credits, custom_price } = req.body
  if (!company_name || !email || !phone) {
    return res.status(400).json({ error: 'company_name, email, phone required' })
  }

  // Generate a temporary password
  const tempPassword = Math.random().toString(36).slice(-10)
  const passwordHash = await bcrypt.hash(tempPassword, 12)
  const apiKey = generateApiKey()

  const { data: subClient, error } = await supabase
    .from('clients')
    .insert({
      name: company_name,
      email,
      phone,
      password_hash: passwordHash,
      api_key: apiKey,
      plan: plan || 'basic',
      reseller_id: reseller.id,
      status: 'active',
      // Custom price per SMS for this sub-client
      custom_sms_price: custom_price || RETAIL_PRICE
    })
    .select().single()

  if (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'Email already exists' })
    return res.status(500).json({ error: error.message })
  }

  // Add initial credits if provided
  if (initial_credits && initial_credits > 0) {
    await supabase.from('billing_transactions').insert({
      client_id: subClient.id,
      type: 'credit',
      amount: initial_credits,
      balance_before: 0,
      balance_after: initial_credits,
      description: `Initial credits from reseller`,
      payment_reference: `RESELLER-${reseller.id}`
    })
  }

  try {
    await EmailService.sendWelcome({
      name: company_name,
      email,
      api_key: apiKey,
      plan: plan || 'basic',
      credits: initial_credits || 0
    })
  } catch (e) {
    logger.warn('Sub-client welcome email failed:', e.message)
  }

  return res.status(201).json({
    success: true,
    sub_client: {
      id: subClient.id,
      name: subClient.name,
      email: subClient.email,
      api_key: apiKey,
      temp_password: tempPassword
    },
    message: 'Sub-client created. Welcome email sent with API key and temporary password.'
  })
})

// ─── ADD CREDITS TO SUB-CLIENT ────────────────────────────────
router.post('/clients/:id/credits', async (req, res) => {
  const { amount, note } = req.body
  if (!amount || amount <= 0) return res.status(400).json({ error: 'Valid amount required' })

  const { data: reseller } = await supabase
    .from('resellers')
    .select('id, status')
    .eq('client_id', req.client.id)
    .single()
  if (!reseller || reseller.status !== 'approved') {
    return res.status(403).json({ error: 'Approved reseller required' })
  }

  // Verify sub-client belongs to this reseller
  const { data: subClient } = await supabase
    .from('clients')
    .select('id, name, email')
    .eq('id', req.params.id)
    .eq('reseller_id', reseller.id)
    .single()
  if (!subClient) return res.status(404).json({ error: 'Sub-client not found' })

  // Get current balance
  const { data: billing } = await supabase.from('billing_transactions').select('amount, type').eq('client_id', subClient.id)
  const currentBalance = (billing || []).reduce((s, b) => b.type === 'credit' ? s + b.amount : s - b.amount, 0)

  await supabase.from('billing_transactions').insert({
    client_id: subClient.id,
    type: 'credit',
    amount,
    balance_before: currentBalance,
    balance_after: currentBalance + amount,
    description: note || `Credits added by reseller`,
    payment_reference: `RESELLER-${reseller.id}`
  })

  // Also deduct from reseller's own credits (they pay wholesale)
  const wholesaleCost = amount * (WHOLESALE_PRICE / RETAIL_PRICE)
  const { data: resBilling } = await supabase.from('billing_transactions').select('amount, type').eq('client_id', req.client.id)
  const resBalance = (resBilling || []).reduce((s, b) => b.type === 'credit' ? s + b.amount : s - b.amount, 0)
  await supabase.from('billing_transactions').insert({
    client_id: req.client.id,
    type: 'debit',
    amount: wholesaleCost,
    balance_before: resBalance,
    balance_after: resBalance - wholesaleCost,
    description: `Wholesale credits for sub-client: ${subClient.name}`
  })

  try {
    await EmailService.sendCreditsAdded(subClient, amount, currentBalance + amount)
  } catch (e) {}

  return res.json({
    success: true,
    credits_added: amount,
    sub_client_new_balance: currentBalance + amount,
    wholesale_cost: parseFloat(wholesaleCost.toFixed(2))
  })
})

// ─── EARNINGS HISTORY ────────────────────────────────────────
router.get('/earnings', async (req, res) => {
  const { data: reseller } = await supabase
    .from('resellers')
    .select('id')
    .eq('client_id', req.client.id)
    .single()
  if (!reseller) return res.status(403).json({ error: 'Reseller account required' })

  const { data: subClients } = await supabase
    .from('clients')
    .select('id, name')
    .eq('reseller_id', reseller.id)

  const subClientIds = (subClients || []).map(c => c.id)
  if (!subClientIds.length) return res.json({ earnings: [], total: 0 })

  const { data: messages } = await supabase
    .from('messages')
    .select('client_id, cost, created_at, status')
    .in('client_id', subClientIds)
    .eq('status', 'delivered')
    .order('created_at', { ascending: false })
    .limit(500)

  const margin = RETAIL_PRICE - WHOLESALE_PRICE
  const total = (messages || []).reduce((s, m) => s + margin, 0)

  return res.json({
    earnings: (messages || []).map(m => ({
      ...m,
      client_name: subClients.find(c => c.id === m.client_id)?.name,
      commission: parseFloat(margin.toFixed(4))
    })),
    total_commission: parseFloat(total.toFixed(2)),
    margin_per_sms: margin,
    wholesale_price: WHOLESALE_PRICE,
    retail_price: RETAIL_PRICE
  })
})

module.exports = router
