// ============================================================
// src/services/WebhookService.js
// When a message is delivered, notify the business client
// The client configured a webhook_url in their account
// You call that URL with the delivery information
// This is what makes your API professional-grade
// ============================================================

const crypto = require('crypto')
const logger = require('../config/logger')
const { supabase } = require('../config/database')

const MAX_RETRY_ATTEMPTS = 3
const RETRY_DELAYS = [5000, 30000, 300000]  // 5s, 30s, 5min

// ── SIGN THE WEBHOOK PAYLOAD ──────────────────────────────
// Send a signature with every webhook so client can verify
// it actually came from you and not from a hacker

function signPayload(payload, secret) {
  return 'sha256=' + crypto
    .createHmac('sha256', secret)
    .update(JSON.stringify(payload))
    .digest('hex')
}

// ── SEND WEBHOOK TO CLIENT ────────────────────────────────
async function sendWebhook(webhookUrl, payload, clientSecret) {
  const signature = signPayload(payload, clientSecret)
  const deliveryId = require('uuid').v4()

  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 10000)  // 10s timeout

    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Nook-Signature': signature,
        'X-Nook-Delivery': deliveryId,
        'X-Nook-Event': payload.event,
        'User-Agent': 'NookSMS-Webhook/1.0'
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    })

    clearTimeout(timeout)

    if (!response.ok) {
      throw new Error(`Webhook responded with ${response.status}`)
    }

    logger.info('Webhook delivered', {
      webhookUrl: webhookUrl.substring(0, 30) + '...',
      deliveryId,
      event: payload.event,
      status: response.status
    })

    return { success: true, deliveryId, status: response.status }

  } catch (err) {
    logger.warn('Webhook delivery failed', {
      webhookUrl: webhookUrl.substring(0, 30) + '...',
      deliveryId,
      error: err.message
    })
    throw err
  }
}

// ── NOTIFY ON MESSAGE DELIVERED ───────────────────────────
async function notifyMessageDelivered(messageId) {
  // Get message with client info
  const { data: message } = await supabase
    .from('messages')
    .select(`
      *,
      clients (webhook_url, webhook_secret, name)
    `)
    .eq('id', messageId)
    .single()

  if (!message) return
  if (!message.clients?.webhook_url) return  // Client has no webhook configured

  const payload = {
    event: 'message.delivered',
    timestamp: new Date().toISOString(),
    data: {
      message_id: message.id,
      to: message.to_number,
      status: message.status,
      network: message.network,
      delivered_at: message.delivered_at,
      cost: message.cost
    }
  }

  // Try to deliver with retries
  for (let attempt = 0; attempt < MAX_RETRY_ATTEMPTS; attempt++) {
    try {
      await sendWebhook(
        message.clients.webhook_url,
        payload,
        message.clients.webhook_secret || process.env.WEBHOOK_SECRET
      )
      return  // Success — stop retrying
    } catch {
      if (attempt < MAX_RETRY_ATTEMPTS - 1) {
        // Wait before retry with exponential backoff
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAYS[attempt]))
      }
    }
  }

  logger.error('Webhook permanently failed after all retries', {
    messageId,
    webhookUrl: message.clients.webhook_url?.substring(0, 30)
  })
}

// ── NOTIFY ON BULK JOB COMPLETE ───────────────────────────
async function notifyBulkComplete(jobId, results) {
  const { data: job } = await supabase
    .from('bulk_jobs')
    .select(`
      *,
      clients (webhook_url, webhook_secret)
    `)
    .eq('id', jobId)
    .single()

  if (!job?.clients?.webhook_url) return

  const payload = {
    event: 'bulk.completed',
    timestamp: new Date().toISOString(),
    data: {
      job_id: jobId,
      total: results.total,
      sent: results.sent,
      failed: results.failed,
      completed_at: new Date().toISOString()
    }
  }

  try {
    await sendWebhook(
      job.clients.webhook_url,
      payload,
      job.clients.webhook_secret || process.env.WEBHOOK_SECRET
    )
  } catch (err) {
    logger.error('Bulk complete webhook failed', { jobId, error: err.message })
  }
}

// ── NOTIFY ON LOW CREDITS ─────────────────────────────────
async function notifyLowCredits(clientId, currentCredits) {
  const { data: client } = await supabase
    .from('clients')
    .select('webhook_url, webhook_secret, name, email')
    .eq('id', clientId)
    .single()

  if (!client?.webhook_url) return

  // Only notify at specific thresholds to avoid spam
  const thresholds = [100, 50, 20, 10]
  const isThreshold = thresholds.some(t =>
    Math.floor(currentCredits) === t || (currentCredits < t && currentCredits > t - 5)
  )

  if (!isThreshold) return

  const payload = {
    event: 'credits.low',
    timestamp: new Date().toISOString(),
    data: {
      current_credits: currentCredits,
      currency: 'DH',
      recharge_url: 'https://nook.ma/billing',
      message: `Your Nook SMS credits are low: ${currentCredits} DH remaining`
    }
  }

  try {
    await sendWebhook(client.webhook_url, payload, client.webhook_secret)
  } catch { /* Non-critical */ }
}

module.exports = {
  notifyMessageDelivered,
  notifyBulkComplete,
  notifyLowCredits
}
