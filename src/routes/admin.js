// ============================================================
// src/routes/admin.js
// Internal admin endpoints — NEVER expose to public
// Protected by X-Admin-Key header (set in your .env)
// You use these to: manage clients, view system stats,
// add credits manually, suspend accounts
// ============================================================

const express = require('express')
const router = express.Router()
const { authenticateAdmin } = require('../middleware/auth')
const { supabase } = require('../config/database')
const { checkGatewayHealth } = require('../services/GatewayService')
const logger = require('../config/logger')

// All admin routes require admin key
router.use(authenticateAdmin)

// ── GET /admin/dashboard ──────────────────────────────────
// Everything you need to know at a glance
router.get('/dashboard', async (req, res) => {
  try {
    const now = new Date()
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString()
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString()

    const [
      clients,
      todayMessages,
      monthMessages,
      recentFailures,
      gatewayHealth,
      lowCreditClients
    ] = await Promise.all([
      // All clients count
      supabase.from('clients').select('id, plan, status', { count: 'exact' }),

      // Today's message stats
      supabase.from('messages').select('status, cost').gte('created_at', todayStart),

      // This month's revenue
      supabase.from('messages').select('cost').gte('created_at', monthStart),

      // Recent failures for debugging
      supabase.from('messages')
        .select('id, to_number, failure_reason, gateway, created_at')
        .eq('status', 'failed')
        .order('created_at', { ascending: false })
        .limit(10),

      // Gateway health
      checkGatewayHealth(),

      // Clients about to run out of credits
      supabase.from('clients')
        .select('id, name, email, credits')
        .lt('credits', 50)
        .eq('status', 'active')
        .order('credits', { ascending: true })
    ])

    const today = todayMessages.data || []
    const month = monthMessages.data || []

    return res.json({
      clients: {
        total: clients.count,
        by_plan: {
          basic: (clients.data || []).filter(c => c.plan === 'basic').length,
          standard: (clients.data || []).filter(c => c.plan === 'standard').length,
          enterprise: (clients.data || []).filter(c => c.plan === 'enterprise').length,
        },
        active: (clients.data || []).filter(c => c.status === 'active').length,
        suspended: (clients.data || []).filter(c => c.status === 'suspended').length,
      },
      today: {
        messages_sent: today.length,
        delivered: today.filter(m => m.status === 'delivered').length,
        failed: today.filter(m => m.status === 'failed').length,
        revenue_dh: today.reduce((s, m) => s + (parseFloat(m.cost) || 0), 0).toFixed(2)
      },
      this_month: {
        revenue_dh: month.reduce((s, m) => s + (parseFloat(m.cost) || 0), 0).toFixed(2)
      },
      gateways: gatewayHealth,
      recent_failures: recentFailures.data || [],
      low_credit_clients: (lowCreditClients.data || []).map(c => ({
        id: c.id,
        name: c.name,
        email: c.email,
        credits: c.credits
      }))
    })
  } catch (err) {
    logger.error('Admin dashboard error', { error: err.message })
    return res.status(500).json({ error: 'Dashboard failed' })
  }
})

// ── GET /admin/clients ────────────────────────────────────
router.get('/clients', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1
    const limit = parseInt(req.query.limit) || 20
    const search = req.query.search

    let query = supabase
      .from('clients')
      .select('id, name, email, phone, plan, status, credits, created_at', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range((page - 1) * limit, page * limit - 1)

    if (search) {
      query = query.or(`name.ilike.%${search}%,email.ilike.%${search}%`)
    }

    const { data, count, error } = await query

    if (error) throw error

    return res.json({
      clients: data,
      pagination: { page, limit, total: count, pages: Math.ceil(count / limit) }
    })
  } catch (err) {
    return res.status(500).json({ error: 'Failed to list clients' })
  }
})

// ── POST /admin/clients/:id/add-credits ───────────────────
// When a client pays (bank transfer) — add credits manually
router.post('/clients/:id/add-credits', async (req, res) => {
  try {
    const { amount, payment_reference, note } = req.body

    if (!amount || amount <= 0) {
      return res.status(400).json({ error: 'Amount must be positive' })
    }

    // Get current credits
    const { data: client, error } = await supabase
      .from('clients')
      .select('credits, name, email')
      .eq('id', req.params.id)
      .single()

    if (error || !client) {
      return res.status(404).json({ error: 'Client not found' })
    }

    const balanceBefore = client.credits
    const balanceAfter = balanceBefore + parseFloat(amount)

    // Update credits
    await supabase
      .from('clients')
      .update({ credits: balanceAfter })
      .eq('id', req.params.id)

    // Record transaction
    await supabase.from('billing_transactions').insert({
      client_id: req.params.id,
      type: 'credit_purchase',
      amount: parseFloat(amount),
      balance_before: balanceBefore,
      balance_after: balanceAfter,
      description: note || `Manual credit addition. Reference: ${payment_reference}`,
    })

    logger.billing('CREDITS_ADDED_MANUALLY', {
      clientId: req.params.id,
      amount,
      balanceBefore,
      balanceAfter,
      adminAction: true
    })

    return res.json({
      success: true,
      client: client.name,
      added: parseFloat(amount),
      new_balance: balanceAfter,
      currency: 'DH'
    })
  } catch (err) {
    return res.status(500).json({ error: 'Failed to add credits' })
  }
})

// ── POST /admin/clients/:id/suspend ───────────────────────
router.post('/clients/:id/suspend', async (req, res) => {
  try {
    const { reason } = req.body

    await supabase
      .from('clients')
      .update({
        status: 'suspended',
        suspension_reason: reason || 'Suspended by admin',
        updated_at: new Date().toISOString()
      })
      .eq('id', req.params.id)

    // Invalidate their API key from cache
    const { invalidateClientCache } = require('../middleware/auth')
    const { data: client } = await supabase
      .from('clients')
      .select('api_key')
      .eq('id', req.params.id)
      .single()

    if (client) invalidateClientCache(client.api_key)

    logger.auth('CLIENT_SUSPENDED', { clientId: req.params.id, reason, adminAction: true })

    return res.json({ success: true, message: 'Client suspended' })
  } catch (err) {
    return res.status(500).json({ error: 'Failed to suspend client' })
  }
})

// ── POST /admin/clients/:id/unsuspend ─────────────────────
router.post('/clients/:id/unsuspend', async (req, res) => {
  try {
    await supabase
      .from('clients')
      .update({
        status: 'active',
        suspension_reason: null,
        updated_at: new Date().toISOString()
      })
      .eq('id', req.params.id)

    logger.auth('CLIENT_UNSUSPENDED', { clientId: req.params.id, adminAction: true })

    return res.json({ success: true, message: 'Client reactivated' })
  } catch (err) {
    return res.status(500).json({ error: 'Failed to unsuspend client' })
  }
})

// ── GET /admin/messages ───────────────────────────────────
// Search all messages across all clients (admin only)
router.get('/messages', async (req, res) => {
  try {
    const { status, gateway, from_date, to_date, phone } = req.query
    const page = parseInt(req.query.page) || 1
    const limit = Math.min(parseInt(req.query.limit) || 50, 200)

    let query = supabase
      .from('messages')
      .select('*, clients(name, email)', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range((page - 1) * limit, page * limit - 1)

    if (status) query = query.eq('status', status)
    if (gateway) query = query.eq('gateway', gateway)
    if (from_date) query = query.gte('created_at', from_date)
    if (to_date) query = query.lte('created_at', to_date)
    if (phone) query = query.eq('to_number', phone)

    const { data, count, error } = await query

    if (error) throw error

    return res.json({
      messages: data,
      pagination: { page, limit, total: count, pages: Math.ceil(count / limit) }
    })
  } catch (err) {
    return res.status(500).json({ error: 'Failed to list messages' })
  }
})

// ── GET /admin/system ─────────────────────────────────────
router.get('/system', async (req, res) => {
  const gatewayHealth = await checkGatewayHealth()

  return res.json({
    server: {
      uptime: process.uptime() + ' seconds',
      memory: process.memoryUsage(),
      node_version: process.version,
      environment: process.env.NODE_ENV
    },
    gateways: gatewayHealth,
    timestamp: new Date().toISOString()
  })
})

module.exports = router
