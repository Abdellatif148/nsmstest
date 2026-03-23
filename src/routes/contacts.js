/**
 * contacts.js — Contact Lists
 * GET    /v1/contacts/lists
 * POST   /v1/contacts/lists
 * GET    /v1/contacts/lists/:id
 * POST   /v1/contacts/lists/:id/import  (CSV upload)
 * GET    /v1/contacts/lists/:id/contacts
 * POST   /v1/contacts                   (add single)
 * DELETE /v1/contacts/:id
 * GET    /v1/contacts/lookup/:phone     (check if exists)
 */
const express = require('express')
const router = express.Router()
const multer = require('multer')
const { supabase } = require('../config/database')
const { authenticateApiKey: authenticate } = require('../middleware/auth')
const logger = require('../config/logger')

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } })

router.use(authenticate)

// ─── LISTS ───────────────────────────────────────────────────
router.get('/lists', async (req, res) => {
  const { data, error } = await supabase
    .from('contact_lists')
    .select('*, contacts(count)')
    .eq('client_id', req.client.id)
    .order('created_at', { ascending: false })
  if (error) return res.status(500).json({ error: error.message })
  return res.json({ lists: data || [] })
})

router.post('/lists', async (req, res) => {
  const { name, description } = req.body
  if (!name) return res.status(400).json({ error: 'Name required' })
  const { data, error } = await supabase
    .from('contact_lists')
    .insert({ client_id: req.client.id, name, description })
    .select().single()
  if (error) return res.status(500).json({ error: error.message })
  return res.status(201).json({ success: true, list: data })
})

router.get('/lists/:id', async (req, res) => {
  const { data: list, error } = await supabase
    .from('contact_lists')
    .select('*')
    .eq('id', req.params.id)
    .eq('client_id', req.client.id)
    .single()
  if (error || !list) return res.status(404).json({ error: 'List not found' })

  const { data: contacts, count } = await supabase
    .from('contacts')
    .select('*', { count: 'exact' })
    .eq('list_id', req.params.id)
    .limit(req.query.limit || 100)
    .range(
      ((req.query.page || 1) - 1) * (req.query.limit || 100),
      (req.query.page || 1) * (req.query.limit || 100) - 1
    )

  return res.json({ list, contacts: contacts || [], total: count || 0 })
})

// ─── CSV IMPORT ──────────────────────────────────────────────
router.post('/lists/:id/import', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'CSV file required' })

  const { data: list } = await supabase
    .from('contact_lists')
    .select('id')
    .eq('id', req.params.id)
    .eq('client_id', req.client.id)
    .single()
  if (!list) return res.status(404).json({ error: 'List not found' })

  const csv = req.file.buffer.toString('utf8')
  const lines = csv.split('\n').filter(l => l.trim())
  const headers = lines[0].toLowerCase().split(',').map(h => h.trim())
  const phoneIdx = headers.findIndex(h => ['phone', 'telephone', 'numero', 'number', 'tel'].includes(h))
  const nameIdx = headers.findIndex(h => ['name', 'nom', 'prenom', 'prénom'].includes(h))

  if (phoneIdx === -1) return res.status(400).json({ error: 'CSV must have a "phone" or "telephone" column' })

  const contacts = []
  const errors = []
  const phoneRegex = /^(\+212|212|0)[5-7]\d{8}$/

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',').map(c => c.trim().replace(/"/g, ''))
    const phone = cols[phoneIdx]?.replace(/\s/g, '')
    if (!phone) continue

    // Normalize Moroccan phone to +212 format
    let normalized = phone
    if (phone.startsWith('0')) normalized = '+212' + phone.slice(1)
    if (phone.startsWith('212')) normalized = '+' + phone

    if (!phoneRegex.test(normalized)) {
      errors.push({ line: i + 1, phone, reason: 'Invalid format' })
      continue
    }

    contacts.push({
      list_id: req.params.id,
      phone: normalized,
      name: nameIdx >= 0 ? cols[nameIdx] : null,
      metadata: {}
    })
  }

  // Batch insert in chunks of 500
  let inserted = 0
  for (let i = 0; i < contacts.length; i += 500) {
    const chunk = contacts.slice(i, i + 500)
    const { count } = await supabase
      .from('contacts')
      .upsert(chunk, { onConflict: 'list_id,phone', ignoreDuplicates: true })
      .select('id', { count: 'exact' })
    inserted += count || chunk.length
  }

  // Update list count
  await supabase
    .from('contact_lists')
    .update({ contact_count: inserted })
    .eq('id', req.params.id)

  logger.info(`Imported ${inserted} contacts to list ${req.params.id}`)

  return res.json({
    success: true,
    imported: inserted,
    errors: errors.slice(0, 20),
    error_count: errors.length,
    message: `${inserted} contacts importés avec succès`
  })
})

// ─── SINGLE CONTACT ──────────────────────────────────────────
router.post('/', async (req, res) => {
  const { list_id, phone, name, metadata } = req.body
  if (!list_id || !phone) return res.status(400).json({ error: 'list_id and phone required' })

  let normalized = phone.replace(/\s/g, '')
  if (normalized.startsWith('0')) normalized = '+212' + normalized.slice(1)

  const { data, error } = await supabase
    .from('contacts')
    .upsert({ list_id, phone: normalized, name, metadata: metadata || {} })
    .select().single()
  if (error) return res.status(500).json({ error: error.message })
  return res.status(201).json({ success: true, contact: data })
})

router.delete('/:id', async (req, res) => {
  // Verify ownership via join
  const { error } = await supabase.rpc('delete_contact_owned_by', {
    p_contact_id: req.params.id,
    p_client_id: req.client.id
  })
  if (error) return res.status(500).json({ error: error.message })
  return res.json({ success: true })
})

router.delete('/lists/:id', async (req, res) => {
  await supabase.from('contacts').delete().eq('list_id', req.params.id)
  const { error } = await supabase
    .from('contact_lists')
    .delete()
    .eq('id', req.params.id)
    .eq('client_id', req.client.id)
  if (error) return res.status(500).json({ error: error.message })
  return res.json({ success: true })
})

module.exports = router
