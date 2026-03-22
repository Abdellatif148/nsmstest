// ============================================================
// src/routes/sms.js — Production SMS endpoints
// ============================================================

const express = require('express')
const router = express.Router()
const { authenticateApiKey, verifyWebhook } = require('../middleware/auth')
const { validate } = require('../middleware/validate')
const { sendSMS, getMessageStatus, getClientMessages } = require('../services/SmsService')
const { addBulkJob, getJobStatus } = require('../queues/BulkSmsQueue')
const { supabase } = require('../config/database')
const logger = require('../config/logger')

// All routes require valid API key
router.use(authenticateApiKey)

// ── POST /send ────────────────────────────────────────────
router.post('/send', validate('sendSMS'), async (req, res) => {
  try {
    const result = await sendSMS({
      to: req.body.to,
      message: req.body.message,
      clientId: req.client.id,
      client: req.client,
      messageType: req.body.message_type,
      senderId: req.body.sender_id
    })

    return res.status(200).json(result)

  } catch (err) {
    if (err.statusCode) {
      return res.status(err.statusCode).json({
        error: err.message,
        code: err.code,
        ...(err.required && { required: err.required }),
        ...(err.available && { available: err.available })
      })
    }

    logger.error('Unexpected SMS send error', { error: err.message, stack: err.stack })
    return res.status(500).json({
      error: 'Internal server error',
      code: 'SERVER_ERROR'
    })
  }
})

// ── POST /bulk ────────────────────────────────────────────
router.post('/bulk', validate('sendBulkSMS'), async (req, res) => {
  try {
    const { recipients, message, sender_id } = req.body

    // Check client has enough credits before queuing
    const estimatedCost = recipients.length * 0.25  // Worst case price
    if (req.client.credits < estimatedCost) {
      return res.status(402).json({
        error: 'Insufficient credits for bulk send',
        code: 'INSUFFICIENT_CREDITS',
        required_minimum: estimatedCost,
        available: req.client.credits,
        tip: 'Actual cost may be lower depending on networks. Add credits at nook.ma/billing'
      })
    }

    // Save bulk job record to database
    const jobRecord = {
      id: require('uuid').v4(),
      client_id: req.client.id,
      total: recipients.length,
      sent: 0,
      failed: 0,
      progress: 0,
      status: 'queued',
      message: message.substring(0, 50) + (message.length > 50 ? '...' : ''),
      created_at: new Date().toISOString()
    }

    await supabase.from('bulk_jobs').insert(jobRecord)

    // Add to queue — returns immediately with job ID
    const queueJobId = await addBulkJob({
      recipients,
      message,
      clientId: req.client.id,
      client: req.client,
      senderId: sender_id,
      jobId: jobRecord.id
    })

    return res.status(202).json({
      accepted: true,
      job_id: jobRecord.id,
      total_recipients: recipients.length,
      estimated_cost: estimatedCost,
      status: 'queued',
      check_status: `/v1/sms/bulk/status/${jobRecord.id}`,
      message: 'Bulk job queued. Check status endpoint for progress.'
    })

  } catch (err) {
    logger.error('Bulk SMS queue error', { error: err.message })
    return res.status(500).json({
      error: 'Failed to queue bulk SMS',
      code: 'QUEUE_ERROR'
    })
  }
})

// ── GET /bulk/status/:jobId ───────────────────────────────
router.get('/bulk/status/:jobId', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('bulk_jobs')
      .select('*')
      .eq('id', req.params.jobId)
      .eq('client_id', req.client.id)  // Security check
      .single()

    if (error || !data) {
      return res.status(404).json({
        error: 'Job not found',
        code: 'JOB_NOT_FOUND'
      })
    }

    return res.json({
      job_id: data.id,
      status: data.status,
      progress: data.progress + '%',
      total: data.total,
      sent: data.sent,
      failed: data.failed,
      created_at: data.created_at,
      completed_at: data.completed_at
    })

  } catch (err) {
    return res.status(500).json({ error: 'Failed to get job status' })
  }
})

// ── GET /status/:messageId ────────────────────────────────
router.get('/status/:messageId', async (req, res) => {
  try {
    const status = await getMessageStatus(req.params.messageId, req.client.id)

    if (!status) {
      return res.status(404).json({
        error: 'Message not found',
        code: 'MESSAGE_NOT_FOUND'
      })
    }

    return res.json(status)

  } catch (err) {
    return res.status(500).json({ error: 'Failed to get message status' })
  }
})

// ── GET /messages ─────────────────────────────────────────
router.get('/messages', validate('queryMessages', 'query'), async (req, res) => {
  try {
    const result = await getClientMessages(req.client.id, {
      page: req.query.page,
      limit: req.query.limit,
      status: req.query.status,
      startDate: req.query.start_date,
      endDate: req.query.end_date
    })

    return res.json(result)

  } catch (err) {
    return res.status(500).json({ error: 'Failed to get messages' })
  }
})

// ── POST /webhook/delivery ────────────────────────────────
// Public endpoint — no API key required
// But verified via webhook signature
router.post('/webhook/delivery', verifyWebhook, async (req, res) => {
  try {
    const { id: gatewayMessageId, status } = req.body

    if (gatewayMessageId) {
      const deliveryStatus = status === 'Success' ? 'delivered' : 'failed'

      await supabase
        .from('messages')
        .update({
          status: deliveryStatus,
          gateway_status: status,
          delivered_at: deliveryStatus === 'delivered' ? new Date().toISOString() : null,
          failure_reason: deliveryStatus === 'failed' ? status : null,
          updated_at: new Date().toISOString()
        })
        .eq('gateway_message_id', gatewayMessageId)

      logger.sms('DELIVERY_REPORT', {
        gatewayMessageId,
        status: deliveryStatus
      })
    }

    // Always 200 to prevent Africa's Talking from retrying
    return res.status(200).send('OK')

  } catch (err) {
    logger.error('Webhook error', { error: err.message })
    return res.status(200).send('OK')  // Still 200
  }
})

module.exports = router
