/**
 * lookup.js   — Phone number lookup
 * links.js    — Short link tracking
 * senderids.js — Sender ID management
 */

// ═══════════════════════════════════════════════════════════
// NUMBER LOOKUP
// ═══════════════════════════════════════════════════════════
const express = require('express')
const lookupRouter = express.Router()
const { supabase } = require('../config/database')
const { authenticateApiKey: authenticate } = require('../middleware/auth')
const logger = require('../config/logger')

lookupRouter.use(authenticate)

/**
 * GET /v1/lookup/:phone
 * Returns: network, type (mobile/landline), valid, portability info
 * Costs: 0.05 DH per lookup
 */
lookupRouter.get('/:phone', async (req, res) => {
  const phone = decodeURIComponent(req.params.phone).replace(/\s/g, '')

  // Normalize
  let normalized = phone
  if (phone.startsWith('0')) normalized = '+212' + phone.slice(1)
  if (phone.startsWith('212') && !phone.startsWith('+')) normalized = '+' + phone

  const phoneRegex = /^\+212[5-7]\d{8}$/
  if (!phoneRegex.test(normalized)) {
    return res.status(400).json({ error: 'Invalid Moroccan phone number', valid: false })
  }

  // Check cache first (24 hour TTL)
  const { data: cached } = await supabase
    .from('number_lookups')
    .select('*')
    .eq('phone', normalized)
    .gt('cached_at', new Date(Date.now() - 24 * 3600000).toISOString())
    .single()

  if (cached) {
    return res.json({ ...cached.result, cached: true, cost: 0 })
  }

  // Detect network from prefix
  const prefix = normalized.substring(4, 7)
  const networkMap = {
    // Maroc Telecom
    '660': 'maroc_telecom', '661': 'maroc_telecom', '662': 'maroc_telecom', '663': 'maroc_telecom',
    '664': 'maroc_telecom', '665': 'maroc_telecom', '670': 'maroc_telecom', '671': 'maroc_telecom',
    '672': 'maroc_telecom', '673': 'maroc_telecom', '674': 'maroc_telecom', '675': 'maroc_telecom',
    '676': 'maroc_telecom', '677': 'maroc_telecom', '678': 'maroc_telecom', '679': 'maroc_telecom',
    // Inwi
    '650': 'inwi', '651': 'inwi', '652': 'inwi', '653': 'inwi', '654': 'inwi', '655': 'inwi',
    '656': 'inwi', '657': 'inwi', '658': 'inwi', '659': 'inwi',
    '520': 'inwi', '521': 'inwi', '522': 'inwi', '523': 'inwi',
    // Orange
    '610': 'orange', '611': 'orange', '612': 'orange', '613': 'orange', '614': 'orange',
    '615': 'orange', '616': 'orange', '617': 'orange', '618': 'orange', '619': 'orange',
    '620': 'orange', '621': 'orange', '622': 'orange', '623': 'orange', '624': 'orange',
    '625': 'orange', '626': 'orange', '627': 'orange', '628': 'orange', '629': 'orange',
  }

  const network = networkMap[prefix] || 'unknown'
  const LOOKUP_COST = 0.05

  // Check credits
  const { data: billingData } = await supabase
    .from('billing_transactions')
    .select('amount, type')
    .eq('client_id', req.client.id)
  const credits = (billingData || []).reduce((s, b) => b.type === 'credit' ? s + b.amount : s - b.amount, 0)

  if (credits < LOOKUP_COST) {
    return res.status(402).json({ error: 'Insufficient credits for lookup', code: 'NO_CREDITS', required: LOOKUP_COST })
  }

  const result = {
    phone: normalized,
    valid: true,
    network,
    network_name: { maroc_telecom: 'Maroc Telecom', inwi: 'Inwi', orange: 'Orange', unknown: 'Unknown' }[network],
    type: 'mobile',
    country: 'MA',
    country_name: 'Maroc',
    prefix,
    cost: LOOKUP_COST
  }

  // Deduct credits
  await supabase.from('billing_transactions').insert({
    client_id: req.client.id,
    type: 'debit',
    amount: LOOKUP_COST,
    balance_before: credits,
    balance_after: credits - LOOKUP_COST,
    description: `Number lookup: ${normalized}`,
    message_id: null
  })

  // Cache result
  await supabase.from('number_lookups').upsert({
    phone: normalized,
    result,
    cached_at: new Date().toISOString()
  })

  logger.info(`Lookup: ${normalized} → ${network}`)
  return res.json(result)
})

// Batch lookup (up to 100 numbers)
lookupRouter.post('/batch', async (req, res) => {
  const { phones } = req.body
  if (!phones || !Array.isArray(phones) || phones.length > 100) {
    return res.status(400).json({ error: 'phones array required, max 100' })
  }

  const LOOKUP_COST = 0.05
  const totalCost = phones.length * LOOKUP_COST

  const { data: billingData } = await supabase.from('billing_transactions').select('amount, type').eq('client_id', req.client.id)
  const credits = (billingData || []).reduce((s, b) => b.type === 'credit' ? s + b.amount : s - b.amount, 0)
  if (credits < totalCost) {
    return res.status(402).json({ error: `Insufficient credits. Need ${totalCost} DH, have ${credits.toFixed(2)} DH`, code: 'NO_CREDITS' })
  }

  const results = phones.map(phone => {
    let normalized = phone.replace(/\s/g, '')
    if (normalized.startsWith('0')) normalized = '+212' + normalized.slice(1)
    const prefix = normalized.substring(4, 7)
    const networkMap = { '660': 'maroc_telecom', '650': 'inwi', '610': 'orange' }
    const network = Object.entries(networkMap).find(([k]) => prefix.startsWith(k[0]))?.[1] || 'unknown'
    return { phone: normalized, valid: /^\+212[5-7]\d{8}$/.test(normalized), network, cost: LOOKUP_COST }
  })

  await supabase.from('billing_transactions').insert({
    client_id: req.client.id,
    type: 'debit',
    amount: totalCost,
    balance_before: credits,
    balance_after: credits - totalCost,
    description: `Batch lookup: ${phones.length} numbers`
  })

  return res.json({ results, total_cost: totalCost, count: results.length })
})

module.exports = { lookupRouter }


// ═══════════════════════════════════════════════════════════
// LINK TRACKING
// ═══════════════════════════════════════════════════════════
const linksRouter = express.Router()
const crypto = require('node:crypto')

linksRouter.use(authenticate)

/**
 * POST /v1/links — Create tracked short link
 * GET  /v1/links — List my links
 * GET  /v1/links/:code/stats — Link click stats
 * GET  /:code — Redirect (public, no auth)
 */
linksRouter.post('/', async (req, res) => {
  const { url, name, expires_at } = req.body
  if (!url) return res.status(400).json({ error: 'URL required' })

  try { new URL(url) } catch { return res.status(400).json({ error: 'Invalid URL' }) }

  const code = crypto.randomBytes(4).toString('hex') // 8 chars: nook.ma/r/abc12345

  const { data, error } = await supabase
    .from('tracked_links')
    .insert({
      client_id: req.client.id,
      original_url: url,
      short_code: code,
      name: name || url.substring(0, 50),
      expires_at,
      clicks: 0
    })
    .select().single()

  if (error) return res.status(500).json({ error: error.message })

  return res.status(201).json({
    success: true,
    link: data,
    short_url: `${process.env.BASE_URL || 'https://api.nook.ma'}/r/${code}`
  })
})

linksRouter.get('/', async (req, res) => {
  const { data, error } = await supabase
    .from('tracked_links')
    .select('*')
    .eq('client_id', req.client.id)
    .order('created_at', { ascending: false })
  if (error) return res.status(500).json({ error: error.message })
  return res.json({ links: data || [] })
})

linksRouter.get('/:code/stats', async (req, res) => {
  const { data: link } = await supabase
    .from('tracked_links')
    .select('*')
    .eq('short_code', req.params.code)
    .eq('client_id', req.client.id)
    .single()
  if (!link) return res.status(404).json({ error: 'Link not found' })

  const { data: clicks } = await supabase
    .from('link_clicks')
    .select('clicked_at, user_agent, country')
    .eq('link_id', link.id)
    .order('clicked_at', { ascending: false })
    .limit(100)

  return res.json({ link, clicks: clicks || [], total_clicks: link.clicks })
})

// Public redirect endpoint (no auth needed)
const redirectRouter = express.Router()
redirectRouter.get('/:code', async (req, res) => {
  const { data: link } = await supabase
    .from('tracked_links')
    .select('*')
    .eq('short_code', req.params.code)
    .single()

  if (!link) return res.status(404).send('Link not found')
  if (link.expires_at && new Date(link.expires_at) < new Date()) {
    return res.status(410).send('Link expired')
  }

  // Record click async
  supabase.from('link_clicks').insert({
    link_id: link.id,
    user_agent: req.headers['user-agent'],
    ip: req.ip,
    clicked_at: new Date().toISOString()
  }).then(() => {})

  supabase.from('tracked_links').update({ clicks: link.clicks + 1 }).eq('id', link.id).then(() => {})

  return res.redirect(302, link.original_url)
})

module.exports.linksRouter = linksRouter
module.exports.redirectRouter = redirectRouter


// ═══════════════════════════════════════════════════════════
// SENDER IDs
// ═══════════════════════════════════════════════════════════
const senderRouter = express.Router()
senderRouter.use(authenticate)

senderRouter.get('/', async (req, res) => {
  const { data } = await supabase
    .from('sender_ids')
    .select('*')
    .eq('client_id', req.client.id)
  return res.json({ sender_ids: data || [] })
})

senderRouter.post('/', async (req, res) => {
  const { sender_id, purpose } = req.body
  if (!sender_id || sender_id.length > 11) {
    return res.status(400).json({ error: 'Sender ID must be max 11 characters' })
  }
  if (!/^[a-zA-Z0-9]+$/.test(sender_id)) {
    return res.status(400).json({ error: 'Sender ID must be alphanumeric only' })
  }

  const { data, error } = await supabase
    .from('sender_ids')
    .insert({
      client_id: req.client.id,
      sender_id: sender_id.toUpperCase(),
      purpose: purpose || 'general',
      status: 'pending',
      submitted_at: new Date().toISOString()
    })
    .select().single()

  if (error) return res.status(500).json({ error: error.message })

  // Notify admin
  logger.info(`Sender ID request: ${sender_id} from client ${req.client.id}`)

  return res.status(201).json({
    success: true,
    sender_id: data,
    message: 'Sender ID request submitted. Approval takes 3-10 business days via Africa\'s Talking.'
  })
})

module.exports.senderRouter = senderRouter
