// ============================================================
// src/services/SmsService.js
// Production SMS service — coordinates everything
// Validates → Routes → Sends → Records → Returns
// ============================================================

const { v4: uuidv4 } = require('uuid')
const { supabase } = require('../config/database')
const { sendWithFailover } = require('./GatewayService')
const logger = require('../config/logger')
const config = require('../config/env')

// ── PHONE VALIDATION AND NORMALIZATION ────────────────────
function normalizePhone(number) {
  const cleaned = String(number).replace(/[\s\-\(\)\.]/g, '')

  // Accept: 0612345678, 212612345678, +212612345678
  if (/^0[5-7]\d{8}$/.test(cleaned)) {
    return '+212' + cleaned.substring(1)
  }
  if (/^212[5-7]\d{8}$/.test(cleaned)) {
    return '+' + cleaned
  }
  if (/^\+212[5-7]\d{8}$/.test(cleaned)) {
    return cleaned
  }

  return null
}

// ── NETWORK DETECTION ─────────────────────────────────────
function detectNetwork(phone) {
  const local = phone.replace('+212', '')
  const prefix = local.substring(0, 2)

  // Maroc Telecom (IAM): 6X where X is 1-8, 7X
  if (/^6[1-8]/.test(prefix) || /^71/.test(prefix)) return 'maroc_telecom'

  // Orange: 60, 69, 79, 5X (landlines under Orange)
  if (['60', '69', '79'].includes(prefix)) return 'orange'

  // Inwi: 70-78
  if (/^7[0-8]/.test(prefix)) return 'inwi'

  return 'unknown'
}

// ── CALCULATE PRICE ───────────────────────────────────────
function calculatePrice(network) {
  return config.pricing[network] || config.pricing.unknown
}

// ── GENERATE MESSAGE ID ───────────────────────────────────
function generateMessageId() {
  return 'nk_' + uuidv4().replace(/-/g, '').substring(0, 20)
}

// ── DEDUCT CLIENT CREDITS ─────────────────────────────────
async function deductCredits(clientId, amount, messageId) {
  // Get current credits
  const { data: client, error } = await supabase
    .from('clients')
    .select('credits')
    .eq('id', clientId)
    .single()

  if (error) throw new Error(`Failed to get client credits: ${error.message}`)

  const balanceBefore = client.credits
  const balanceAfter = balanceBefore - amount

  // Update credits
  await supabase
    .from('clients')
    .update({ credits: balanceAfter })
    .eq('id', clientId)

  // Record transaction for audit trail
  await supabase.from('billing_transactions').insert({
    client_id: clientId,
    type: 'sms_charge',
    amount: -amount,
    balance_before: balanceBefore,
    balance_after: balanceAfter,
    description: `SMS sent`,
    message_id: messageId
  })

  logger.billing('CHARGED', {
    clientId,
    amount,
    balanceBefore,
    balanceAfter,
    messageId
  })

  return balanceAfter
}

// ── SEND SINGLE SMS ───────────────────────────────────────
async function sendSMS({ to, message, clientId, client, messageType = 'transactional', senderId }) {

  // Validate and normalize
  const normalizedPhone = normalizePhone(to)
  if (!normalizedPhone) {
    throw Object.assign(new Error(`Invalid phone number: ${to}`), {
      code: 'INVALID_PHONE',
      statusCode: 400
    })
  }

  if (!message || message.trim().length === 0) {
    throw Object.assign(new Error('Message cannot be empty'), {
      code: 'EMPTY_MESSAGE',
      statusCode: 400
    })
  }

  if (message.length > 160) {
    throw Object.assign(new Error(`Message too long: ${message.length} chars (max 160)`), {
      code: 'MESSAGE_TOO_LONG',
      statusCode: 400
    })
  }

  // Detect network for routing and pricing
  const network = detectNetwork(normalizedPhone)
  const cost = calculatePrice(network)

  // Check credits BEFORE sending
  if (client.credits < cost) {
    throw Object.assign(new Error('Insufficient credits'), {
      code: 'NO_CREDITS',
      statusCode: 402,
      required: cost,
      available: client.credits
    })
  }

  // Generate our tracking ID
  const messageId = generateMessageId()

  // Save message record BEFORE sending
  // This ensures we have a record even if the server crashes mid-send
  const messageRecord = {
    id: messageId,
    client_id: clientId,
    to_number: normalizedPhone,
    message: message.trim(),
    message_length: message.length,
    network,
    message_type: messageType,
    sender_id: senderId || client.default_sender_id || 'NOOK',
    status: 'pending',
    gateway: 'africastalking',  // Will be updated after send
    cost,
    created_at: new Date().toISOString()
  }

  const { error: insertError } = await supabase
    .from('messages')
    .insert(messageRecord)

  if (insertError) {
    logger.error('Failed to save message record', { error: insertError.message })
    // Continue anyway — better to send without record than not send
  }

  // ── ACTUALLY SEND ──────────────────────────────────────
  try {
    const gatewayResult = await sendWithFailover(
      normalizedPhone,
      message.trim(),
      messageRecord.sender_id
    )

    // Update record with success
    await supabase
      .from('messages')
      .update({
        status: 'sent',
        gateway: gatewayResult.gateway,
        gateway_message_id: gatewayResult.gatewayMessageId,
        sent_at: new Date().toISOString()
      })
      .eq('id', messageId)

    // Deduct credits
    const remainingCredits = await deductCredits(clientId, cost, messageId)

    return {
      success: true,
      message_id: messageId,
      to: normalizedPhone,
      network,
      status: 'sent',
      cost,
      remaining_credits: remainingCredits,
      currency: 'DH'
    }

  } catch (sendErr) {
    // Update record with failure
    await supabase
      .from('messages')
      .update({
        status: 'failed',
        failure_reason: sendErr.message,
        updated_at: new Date().toISOString()
      })
      .eq('id', messageId)

    logger.error('SMS send failed', {
      messageId,
      to: normalizedPhone,
      error: sendErr.message
    })

    throw Object.assign(new Error(`Failed to send SMS: ${sendErr.message}`), {
      code: 'SEND_FAILED',
      statusCode: 502
    })
  }
}

// ── GET MESSAGE STATUS ────────────────────────────────────
async function getMessageStatus(messageId, clientId) {
  const { data, error } = await supabase
    .from('messages')
    .select('*')
    .eq('id', messageId)
    .eq('client_id', clientId)  // Security: clients can only see their own messages
    .single()

  if (error || !data) return null

  return {
    message_id: data.id,
    to: data.to_number,
    status: data.status,
    network: data.network,
    gateway: data.gateway,
    cost: data.cost,
    created_at: data.created_at,
    sent_at: data.sent_at,
    delivered_at: data.delivered_at,
    failure_reason: data.failure_reason
  }
}

// ── GET CLIENT MESSAGES (PAGINATED) ──────────────────────
async function getClientMessages(clientId, { page = 1, limit = 50, status, startDate, endDate } = {}) {
  let query = supabase
    .from('messages')
    .select('*', { count: 'exact' })
    .eq('client_id', clientId)
    .order('created_at', { ascending: false })
    .range((page - 1) * limit, page * limit - 1)

  if (status) query = query.eq('status', status)
  if (startDate) query = query.gte('created_at', startDate)
  if (endDate) query = query.lte('created_at', endDate)

  const { data, count, error } = await query

  if (error) throw new Error(error.message)

  return {
    messages: data,
    pagination: {
      page,
      limit,
      total: count,
      pages: Math.ceil(count / limit)
    }
  }
}

module.exports = { sendSMS, getMessageStatus, getClientMessages, normalizePhone, detectNetwork }
