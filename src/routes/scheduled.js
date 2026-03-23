/**
 * scheduled.js — Scheduled SMS sends
 * POST   /v1/scheduled
 * GET    /v1/scheduled
 * DELETE /v1/scheduled/:id
 * POST   /v1/scheduled/:id/cancel
 */
const express = require('express')
const router = express.Router()
const { supabase } = require('../config/database')
const { authenticateApiKey: authenticate } = require('../middleware/auth')
const Joi = require('joi')

router.use(authenticate)

router.post('/', async (req, res) => {
  const schema = Joi.object({
    to: Joi.alternatives().try(
      Joi.string().required(),
      Joi.array().items(Joi.string()).required()
    ).required(),
    message: Joi.string().min(1).max(160).required(),
    sender_id: Joi.string().max(11).optional(),
    scheduled_at: Joi.string().isoDate().required(),
    timezone: Joi.string().default('Africa/Casablanca'),
    list_id: Joi.string().uuid().optional(),
    template_id: Joi.string().uuid().optional(),
    name: Joi.string().max(100).optional()
  })
  const { error, value } = schema.validate(req.body)
  if (error) return res.status(400).json({ error: error.details[0].message })

  // Must be at least 5 minutes in future
  const scheduledDate = new Date(value.scheduled_at)
  if (scheduledDate < new Date(Date.now() + 5 * 60 * 1000)) {
    return res.status(400).json({ error: 'Schedule time must be at least 5 minutes in the future', code: 'INVALID_SCHEDULE_TIME' })
  }

  const recipients = Array.isArray(value.to) ? value.to : [value.to]

  const { data, error: err } = await supabase
    .from('scheduled_messages')
    .insert({
      client_id: req.client.id,
      recipients,
      message: value.message,
      sender_id: value.sender_id,
      scheduled_at: value.scheduled_at,
      timezone: value.timezone,
      list_id: value.list_id,
      template_id: value.template_id,
      name: value.name || `Scheduled ${new Date(value.scheduled_at).toLocaleDateString('fr-MA')}`,
      status: 'pending',
      total_recipients: recipients.length
    })
    .select().single()

  if (err) return res.status(500).json({ error: err.message })
  return res.status(201).json({ success: true, scheduled: data })
})

router.get('/', async (req, res) => {
  const { data, error } = await supabase
    .from('scheduled_messages')
    .select('*')
    .eq('client_id', req.client.id)
    .order('scheduled_at', { ascending: true })
  if (error) return res.status(500).json({ error: error.message })
  return res.json({ scheduled: data || [] })
})

router.delete('/:id', async (req, res) => {
  const { data } = await supabase
    .from('scheduled_messages')
    .update({ status: 'cancelled' })
    .eq('id', req.params.id)
    .eq('client_id', req.client.id)
    .eq('status', 'pending')
    .select().single()
  if (!data) return res.status(404).json({ error: 'Scheduled message not found or already sent' })
  return res.json({ success: true })
})

module.exports = router
