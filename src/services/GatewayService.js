// src/services/GatewayService.js — FIXED VERSION
const AfricasTalking = require('africastalking')
const config = require('../config/env')
const logger = require('../config/logger')
const { supabase } = require('../config/database')

let AT, atSMS
try {
  AT = AfricasTalking({
    apiKey: config.gateways.africastalking.apiKey,
    username: config.gateways.africastalking.username,
  })
  atSMS = AT.SMS
  logger.info('Africa s Talking initialized')
} catch (err) {
  logger.error('Failed to init AT', { error: err.message })
}

const gatewayFailures = { africastalking: 0, vonage: 0, infobip: 0 }
const FAILURE_THRESHOLD = 3

function selectGateway() {
  if (gatewayFailures.africastalking < FAILURE_THRESHOLD) return 'africastalking'
  if (config.gateways.vonage.enabled && gatewayFailures.vonage < FAILURE_THRESHOLD) return 'vonage'
  if (config.gateways.infobip.enabled && gatewayFailures.infobip < FAILURE_THRESHOLD) return 'infobip'
  gatewayFailures.africastalking = 0
  return 'africastalking'
}

async function sendViaAT(to, message, senderId) {
  if (!atSMS) throw new Error('Africa s Talking not initialized')
  try {
    const response = await atSMS.send({
      to: [to],
      message
    })
    logger.info('AT raw response', { response: JSON.stringify(response) })
    if (response && response.SMSMessageData) {
      const recipients = response.SMSMessageData.Recipients || []
      if (recipients.length === 0) {
        throw new Error('AT: No recipients. Msg: ' + (response.SMSMessageData.Message || 'unknown'))
      }
      const r = recipients[0]
      const ok = r.status === 'Success' || r.statusCode === 101 || String(r.statusCode) === '101'
      if (ok) {
        gatewayFailures.africastalking = 0
        return { gateway: 'africastalking', gatewayMessageId: r.messageId, cost: config.gateways.africastalking.cost, success: true }
      }
      throw new Error('AT failed: status=' + r.status + ' code=' + r.statusCode)
    }
    if (Array.isArray(response) && response[0]) {
      const r = response[0]
      if (r.status === 'Success' || r.statusCode === 101) {
        gatewayFailures.africastalking = 0
        return { gateway: 'africastalking', gatewayMessageId: r.messageId, cost: config.gateways.africastalking.cost, success: true }
      }
    }
    throw new Error('AT unexpected response: ' + JSON.stringify(response))
  } catch (err) {
    gatewayFailures.africastalking++
    logger.error('Africa s Talking error', { error: err.message, consecutiveFailures: gatewayFailures.africastalking })
    throw err
  }
}

async function sendViaVonage(to, message, senderId) {
  if (!config.gateways.vonage.enabled) throw new Error('Vonage not configured')
  try {
    const response = await fetch('https://rest.nexmo.com/sms/json', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ api_key: config.gateways.vonage.apiKey, api_secret: config.gateways.vonage.apiSecret, to: to.replace('+', ''), from: senderId || config.gateways.vonage.from, text: message })
    })
    const data = await response.json()
    const result = data.messages[0]
    if (result.status === '0') {
      gatewayFailures.vonage = 0
      return { gateway: 'vonage', gatewayMessageId: result['message-id'], cost: config.gateways.vonage.cost, success: true }
    }
    throw new Error('Vonage error: ' + result['error-text'])
  } catch (err) {
    gatewayFailures.vonage++
    logger.error('Vonage error', { error: err.message })
    throw err
  }
}

async function sendViaInfobip(to, message, senderId) {
  if (!config.gateways.infobip.enabled) throw new Error('Infobip not configured')
  try {
    const response = await fetch(config.gateways.infobip.baseUrl + '/sms/2/text/advanced', {
      method: 'POST',
      headers: { 'Authorization': 'App ' + config.gateways.infobip.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ from: senderId || 'NOOK', destinations: [{ to }], text: message }] })
    })
    const data = await response.json()
    const result = data.messages[0]
    if (result.status.groupName === 'PENDING' || result.status.groupName === 'DELIVERED') {
      gatewayFailures.infobip = 0
      return { gateway: 'infobip', gatewayMessageId: result.messageId, cost: config.gateways.infobip.cost, success: true }
    }
    throw new Error('Infobip: ' + result.status.description)
  } catch (err) {
    gatewayFailures.infobip++
    logger.error('Infobip error', { error: err.message })
    throw err
  }
}

async function sendWithFailover(to, message, senderId, preferredGateway = null) {
  const gateway = preferredGateway || selectGateway()
  const senders = { africastalking: sendViaAT, vonage: sendViaVonage, infobip: sendViaInfobip }
  try {
    return await senders[gateway](to, message, senderId)
  } catch (primaryErr) {
    logger.warn('Primary gateway ' + gateway + ' failed', { error: primaryErr.message })
    const fallbacks = ['africastalking', 'vonage', 'infobip'].filter(g => {
      if (g === gateway) return false
      if (g === 'vonage' && !config.gateways.vonage.enabled) return false
      if (g === 'infobip' && !config.gateways.infobip.enabled) return false
      return true
    })
    for (const fallback of fallbacks) {
      try {
        return await senders[fallback](to, message, senderId)
      } catch (e) {
        logger.error('Fallback ' + fallback + ' failed', { error: e.message })
      }
    }
    throw new Error('All gateways failed. Primary: ' + primaryErr.message)
  }
}

async function checkGatewayHealth() {
  const health = {
    africastalking: { status: gatewayFailures.africastalking < FAILURE_THRESHOLD ? 'healthy' : 'degraded' },
    vonage: { status: !config.gateways.vonage.enabled ? 'not_configured' : gatewayFailures.vonage < FAILURE_THRESHOLD ? 'healthy' : 'degraded' },
    infobip: { status: !config.gateways.infobip.enabled ? 'not_configured' : gatewayFailures.infobip < FAILURE_THRESHOLD ? 'healthy' : 'degraded' }
  }
  try {
    await supabase.from('gateway_health').insert(Object.entries(health).map(([gateway, data]) => ({ gateway, status: data.status, checked_at: new Date().toISOString() })))
  } catch { }
  return health
}

module.exports = { sendWithFailover, checkGatewayHealth, selectGateway }

