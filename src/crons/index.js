// ============================================================
// src/crons/index.js
// Scheduled background tasks that run automatically
// Like alarm clocks for your server
// ============================================================

const cron = require('node-cron')
const logger = require('../config/logger')
const { supabase } = require('../config/database')
const { checkGatewayHealth } = require('../services/GatewayService')
const { cleanupExpiredOtps } = require('../services/OtpService')
const { notifyLowCredits } = require('../services/WebhookService')

// ── CRON SCHEDULE REFERENCE ───────────────────────────────
// Format: second minute hour day month weekday
// Example: '0 * * * *' = every hour at :00
//          '*/5 * * * *' = every 5 minutes
//          '0 2 * * *' = every day at 2:00am

// ── GATEWAY HEALTH CHECK — every 5 minutes ────────────────
cron.schedule('*/5 * * * *', async () => {
  try {
    const health = await checkGatewayHealth()

    // Alert if any gateway is degraded
    Object.entries(health).forEach(([gateway, status]) => {
      if (status.status === 'degraded') {
        logger.warn('ALERT: Gateway degraded', { gateway, ...status })
        // In production: send alert to your monitoring tool
        // Slack webhook, PagerDuty, email, etc.
      }
    })

  } catch (err) {
    logger.error('Gateway health check failed', { error: err.message })
  }
}, {
  name: 'gateway-health-check'
})

// ── CLEANUP EXPIRED OTPs — every hour ─────────────────────
cron.schedule('0 * * * *', async () => {
  try {
    const deleted = await cleanupExpiredOtps()
    if (deleted > 0) {
      logger.info('Expired OTP cleanup', { deleted })
    }
  } catch (err) {
    logger.error('OTP cleanup failed', { error: err.message })
  }
}, {
  name: 'otp-cleanup'
})

// ── LOW CREDITS NOTIFICATIONS — every 6 hours ─────────────
cron.schedule('0 */6 * * *', async () => {
  try {
    // Find all clients with low credits
    const threshold = 100  // Less than 100 DH
    const { data: lowCreditClients } = await supabase
      .from('clients')
      .select('id, credits, email, name')
      .lt('credits', threshold)
      .eq('status', 'active')
      .gt('credits', 0)  // Not zero — they already know

    if (!lowCreditClients?.length) return

    logger.info('Low credit notifications', { count: lowCreditClients.length })

    for (const client of lowCreditClients) {
      await notifyLowCredits(client.id, client.credits)
    }

  } catch (err) {
    logger.error('Low credits notification failed', { error: err.message })
  }
}, {
  name: 'low-credits-alert'
})

// ── DAILY DELIVERY STATS — every day at midnight ──────────
cron.schedule('0 0 * * *', async () => {
  try {
    const yesterday = new Date()
    yesterday.setDate(yesterday.getDate() - 1)
    yesterday.setHours(0, 0, 0, 0)

    const endOfYesterday = new Date(yesterday)
    endOfYesterday.setHours(23, 59, 59, 999)

    // Get yesterday's stats
    const { data: messages } = await supabase
      .from('messages')
      .select('status, cost, gateway')
      .gte('created_at', yesterday.toISOString())
      .lte('created_at', endOfYesterday.toISOString())

    if (!messages) return

    const stats = {
      date: yesterday.toISOString().split('T')[0],
      total: messages.length,
      delivered: messages.filter(m => m.status === 'delivered').length,
      failed: messages.filter(m => m.status === 'failed').length,
      revenue: messages.reduce((sum, m) => sum + (parseFloat(m.cost) || 0), 0).toFixed(2),
      byGateway: {}
    }

    messages.forEach(m => {
      if (!stats.byGateway[m.gateway]) stats.byGateway[m.gateway] = 0
      stats.byGateway[m.gateway]++
    })

    stats.deliveryRate = stats.total > 0
      ? ((stats.delivered / stats.total) * 100).toFixed(1) + '%'
      : '0%'

    logger.info('Daily stats', stats)

    // Save daily summary to database
    await supabase.from('daily_stats').upsert({
      date: stats.date,
      total_messages: stats.total,
      delivered: stats.delivered,
      failed: stats.failed,
      revenue_dh: parseFloat(stats.revenue),
      delivery_rate: parseFloat(stats.deliveryRate),
      created_at: new Date().toISOString()
    })

  } catch (err) {
    logger.error('Daily stats failed', { error: err.message })
  }
}, {
  name: 'daily-stats'
})

// ── STALE PENDING MESSAGES — every 30 minutes ─────────────
// Messages stuck in "pending" for more than 30 minutes are likely failed
cron.schedule('*/30 * * * *', async () => {
  try {
    const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString()

    const { count } = await supabase
      .from('messages')
      .update({ status: 'failed', failure_reason: 'timeout_no_delivery_report' })
      .eq('status', 'pending')
      .lt('created_at', thirtyMinutesAgo)
      .select('*', { count: 'exact', head: true })

    if (count > 0) {
      logger.warn('Marked stale messages as failed', { count })
    }

  } catch (err) {
    logger.error('Stale message cleanup failed', { error: err.message })
  }
}, {
  name: 'stale-message-cleanup'
})

// ── DATABASE SIZE MONITORING — once a day ─────────────────
cron.schedule('0 3 * * *', async () => {
  try {
    // Count total records — alert if approaching limits
    const { count: messageCount } = await supabase
      .from('messages')
      .select('*', { count: 'exact', head: true })

    const { count: clientCount } = await supabase
      .from('clients')
      .select('*', { count: 'exact', head: true })

    logger.info('Database stats', {
      messages: messageCount,
      clients: clientCount
    })

    // Supabase free tier: 500MB storage
    // At ~500 bytes per message: 500MB ≈ 1,000,000 messages
    if (messageCount > 800000) {
      logger.warn('ALERT: Approaching database storage limit. Consider upgrading Supabase plan.')
    }

  } catch (err) {
    logger.error('DB monitoring failed', { error: err.message })
  }
}, {
  name: 'db-monitoring'
})

logger.info('Cron jobs scheduled', {
  jobs: [
    'gateway-health: every 5 minutes',
    'otp-cleanup: every hour',
    'low-credits: every 6 hours',
    'daily-stats: midnight',
    'stale-messages: every 30 minutes',
    'db-monitoring: 3am daily'
  ]
})

module.exports = {}  // Crons start when this file is imported
