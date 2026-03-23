/**
 * templates.js — Message Templates
 * GET    /v1/templates
 * POST   /v1/templates
 * PUT    /v1/templates/:id
 * DELETE /v1/templates/:id
 */
const express = require('express')
const router = express.Router()
const Joi = require('joi')
const { supabase } = require('../config/database')
const { authenticateApiKey: authenticate } = require('../middleware/auth')
router.use(authenticate)

router.get('/', async (req, res) => {
  const { data, error } = await supabase
    .from('templates')
    .select('*')
    .eq('client_id', req.client.id)
    .order('created_at', { ascending: false })
  if (error) return res.status(500).json({ error: error.message })
  return res.json({ templates: data || [], count: (data || []).length })
})

router.post('/', async (req, res) => {
  const schema = Joi.object({
    name: Joi.string().min(1).max(100).required(),
    content: Joi.string().min(1).max(160).required(),
    category: Joi.string().valid('otp', 'transactional', 'promotional', 'notification').default('transactional'),
    variables: Joi.array().items(Joi.string()).default([])
  })
  const { error, value } = schema.validate(req.body)
  if (error) return res.status(400).json({ error: error.details[0].message })

  // Extract variables from template like {NAME}, {CODE}
  const vars = [...value.content.matchAll(/\{([A-Z_]+)\}/g)].map(m => m[1])

  const { data, error: err } = await supabase
    .from('templates')
    .insert({ client_id: req.client.id, ...value, variables: vars })
    .select().single()
  if (err) return res.status(500).json({ error: err.message })
  return res.status(201).json({ success: true, template: data })
})

router.put('/:id', async (req, res) => {
  const { data, error } = await supabase
    .from('templates')
    .update(req.body)
    .eq('id', req.params.id)
    .eq('client_id', req.client.id)
    .select().single()
  if (error) return res.status(500).json({ error: error.message })
  if (!data) return res.status(404).json({ error: 'Template not found' })
  return res.json({ success: true, template: data })
})

router.delete('/:id', async (req, res) => {
  const { error } = await supabase
    .from('templates')
    .delete()
    .eq('id', req.params.id)
    .eq('client_id', req.client.id)
  if (error) return res.status(500).json({ error: error.message })
  return res.json({ success: true })
})

module.exports = router
