/**
 * crons/index.js — All background jobs
 *
 * Schedule (cron syntax):
 * ┌───── second (0-59)
 * │ ┌──── minute (0-59)
 * │ │ ┌─── hour (0-23)
 * │ │ │ ┌── day of month (1-31)
 * │ │ │ │ ┌─ month (1-12)
 * │ │ │ │ │ ┌ day of week (0-6)
 */
const cron = require('node-cron')
const { supabase } = require('../config/database')
const logger = require('../config/logger')
const EmailService = require('../services/EmailService')
const SmsService = require('../services/SmsService')

function startCrons() {
  logger.info('Starting cron jobs...')

  // ── 1. GATEWAY HEALTH CHECK — every 5 minutes ─────────────
  cron.schedule('*/5 * * * *', async () => {
    try {
      const AT = require('africastalking')({
        apiKey: process.env.AT_API_KEY,
        username: process.env.AT_USERNAME
      })
      // Ping by checking application data
      await AT.APPLICATION.fetchApplicationData()
      await supabase.from('gateway_health').upsert({
        gateway: 'africastalking',
        status: 'healthy',
        checked_at: new Date().toISOString()
      })
    } catch (e) {
      await supabase.from('gateway_health').upsert({
        gateway: 'africastalking',
        status: 'degraded',
        error: e.message,
        checked_at: new Date().toISOString()
      })
      logger.error('Gateway health check failed:', e.message)
    }
  })

  // ── 2. PROCESS SCHEDULED MESSAGES — every minute ──────────
  cron.schedule('* * * * *', async () => {
    try {
      const now = new Date().toISOString()
      const { data: pending } = await supabase
        .from('scheduled_messages')
        .select('*')
        .eq('status', 'pending')
        .lte('scheduled_at', now)
        .limit(50)

      if (!pending || pending.length === 0) return

      for (const scheduled of pending) {
        try {
          // Mark as processing first
          await supabase
            .from('scheduled_messages')
            .update({ status: 'processing', started_at: now })
            .eq('id', scheduled.id)

          let recipients = scheduled.recipients || []

          // If has list_id, get contacts from list
          if (scheduled.list_id) {
            const { data: contacts } = await supabase
              .from('contacts')
              .select('phone')
              .eq('list_id', scheduled.list_id)
            recipients = (contacts || []).map(c => c.phone)
          }

          if (recipients.length === 0) {
            await supabase.from('scheduled_messages')
              .update({ status: 'failed', error: 'No recipients' })
              .eq('id', scheduled.id)
            continue
          }

          // Send bulk or single
          if (recipients.length === 1) {
            await SmsService.sendSMS({
              clientId: scheduled.client_id,
              to: recipients[0],
              message: scheduled.message,
              senderId: scheduled.sender_id,
              messageType: 'transactional',
              scheduledJobId: scheduled.id
            })
          } else {
            // Queue as bulk job
            const { addBulkJob } = require('../queues/BulkSmsQueue')
            await addBulkJob.add({
              clientId: scheduled.client_id,
              recipients,
              message: scheduled.message,
              senderId: scheduled.sender_id,
              scheduledJobId: scheduled.id
            })
          }

          await supabase.from('scheduled_messages')
            .update({
              status: 'completed',
              completed_at: new Date().toISOString(),
              total_recipients: recipients.length
            })
            .eq('id', scheduled.id)

          logger.info(`Scheduled message ${scheduled.id} sent to ${recipients.length} recipients`)
        } catch (e) {
          await supabase.from('scheduled_messages')
            .update({ status: 'failed', error: e.message })
            .eq('id', scheduled.id)
          logger.error(`Scheduled message ${scheduled.id} failed:`, e.message)
        }
      }
    } catch (e) {
      logger.error('Scheduled message cron error:', e.message)
    }
  })

  // ── 3. LOW CREDITS ALERT — every 6 hours ──────────────────
  cron.schedule('0 */6 * * *', async () => {
    try {
      const { data: clients } = await supabase
        .from('clients')
        .select('id, name, email, plan')
        .eq('status', 'active')

      const THRESHOLD = 100 // DH

      for (const client of (clients || [])) {
        const { data: billing } = await supabase
          .from('billing')
          .select('amount, type')
          .eq('client_id', client.id)

        const credits = (billing || []).reduce((s, b) => b.type === 'credit' ? s + b.amount : s - b.amount, 0)

        if (credits > 0 && credits < THRESHOLD) {
          // Check if we already sent alert in last 24h
          const { data: recentAlert } = await supabase
            .from('email_logs')
            .select('id')
            .eq('client_id', client.id)
            .eq('type', 'low_credits')
            .gt('sent_at', new Date(Date.now() - 24 * 3600000).toISOString())
            .single()

          if (!recentAlert) {
            try {
              await EmailService.sendLowCreditsWarning({ ...client, credits: credits.toFixed(2) })
              await supabase.from('email_logs').insert({
                client_id: client.id,
                type: 'low_credits',
                sent_at: new Date().toISOString()
              })
              logger.info(`Low credits alert sent to ${client.email}`)
            } catch (e) {
              logger.error(`Low credits email failed for ${client.email}:`, e.message)
            }
          }
        }
      }
    } catch (e) {
      logger.error('Low credits cron error:', e.message)
    }
  })

  // ── 4. DAILY STATS SNAPSHOT — every day at midnight ───────
  cron.schedule('0 0 * * *', async () => {
    try {
      const yesterday = new Date(Date.now() - 86400000)
      const startOfDay = new Date(yesterday.setHours(0, 0, 0, 0)).toISOString()
      const endOfDay = new Date(yesterday.setHours(23, 59, 59, 999)).toISOString()

      const { data: messages } = await supabase
        .from('messages')
        .select('client_id, status, cost, network')
        .gte('created_at', startOfDay)
        .lte('created_at', endOfDay)

      if (!messages) return

      // Group by client
      const statsMap = {}
      for (const msg of messages) {
        if (!statsMap[msg.client_id]) {
          statsMap[msg.client_id] = { sent: 0, delivered: 0, failed: 0, cost: 0 }
        }
        statsMap[msg.client_id].sent++
        if (msg.status === 'delivered') statsMap[msg.client_id].delivered++
        if (msg.status === 'failed') statsMap[msg.client_id].failed++
        statsMap[msg.client_id].cost += msg.cost || 0
      }

      for (const [clientId, stats] of Object.entries(statsMap)) {
        await supabase.from('daily_stats').upsert({
          client_id: clientId,
          date: startOfDay.split('T')[0],
          sent: stats.sent,
          delivered: stats.delivered,
          failed: stats.failed,
          cost_dh: parseFloat(stats.cost.toFixed(4)),
          delivery_rate: stats.sent > 0 ? parseFloat(((stats.delivered / stats.sent) * 100).toFixed(2)) : 0
        })
      }

      logger.info(`Daily stats snapshot: ${Object.keys(statsMap).length} clients`)
    } catch (e) {
      logger.error('Daily stats cron error:', e.message)
    }
  })

  // ── 5. MONTHLY REPORT — 1st of every month at 8am ─────────
  cron.schedule('0 8 1 * *', async () => {
    try {
      const now = new Date()
      const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1)
      const monthName = lastMonth.toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' })
      const startOfMonth = lastMonth.toISOString()
      const endOfMonth = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59).toISOString()

      const { data: clients } = await supabase
        .from('clients')
        .select('id, name, email, plan')
        .eq('status', 'active')

      for (const client of (clients || [])) {
        const { data: messages } = await supabase
          .from('messages')
          .select('status, cost')
          .eq('client_id', client.id)
          .gte('created_at', startOfMonth)
          .lte('created_at', endOfMonth)

        if (!messages || messages.length === 0) continue

        const sent = messages.length
        const delivered = messages.filter(m => m.status === 'delivered').length
        const cost = messages.reduce((s, m) => s + (m.cost || 0), 0)

        const { data: billing } = await supabase
          .from('billing')
          .select('amount, type')
          .eq('client_id', client.id)
        const credits = (billing || []).reduce((s, b) => b.type === 'credit' ? s + b.amount : s - b.amount, 0)

        try {
          await EmailService.sendMonthlyReport(
            { ...client, credits: credits.toFixed(2) },
            {
              month: monthName,
              sent,
              delivered,
              delivery_rate: sent > 0 ? `${((delivered / sent) * 100).toFixed(1)}%` : '0%',
              cost_dh: cost.toFixed(2)
            }
          )
          logger.info(`Monthly report sent to ${client.email}`)
        } catch (e) {
          logger.error(`Monthly report failed for ${client.email}:`, e.message)
        }
      }
    } catch (e) {
      logger.error('Monthly report cron error:', e.message)
    }
  })

  // ── 6. STALE MESSAGES CLEANUP — every 30 minutes ──────────
  cron.schedule('*/30 * * * *', async () => {
    try {
      const staleTime = new Date(Date.now() - 30 * 60 * 1000).toISOString()
      const { data: stale } = await supabase
        .from('messages')
        .select('id')
        .eq('status', 'pending')
        .lt('created_at', staleTime)
      if (stale && stale.length > 0) {
        await supabase
          .from('messages')
          .update({ status: 'failed', gateway_response: 'Timeout: no delivery report received' })
          .in('id', stale.map(m => m.id))
        logger.info(`Marked ${stale.length} stale messages as failed`)
      }
    } catch (e) {
      logger.error('Stale messages cron error:', e.message)
    }
  })

  // ── 7. OTP CLEANUP — every hour ───────────────────────────
  cron.schedule('0 * * * *', async () => {
    try {
      const expiredTime = new Date(Date.now() - 15 * 60 * 1000).toISOString()
      const { count } = await supabase
        .from('otp_codes')
        .delete()
        .lt('expires_at', expiredTime)
        .select('id', { count: 'exact' })
      if (count > 0) logger.info(`Cleaned up ${count} expired OTP codes`)
    } catch (e) {
      logger.error('OTP cleanup cron error:', e.message)
    }
  })

  // ── 8. CLEANUP EXPIRED LINKS — every 24h ──────────────────
  cron.schedule('0 3 * * *', async () => {
    try {
      const { count } = await supabase
        .from('tracked_links')
        .delete()
        .not('expires_at', 'is', null)
        .lt('expires_at', new Date().toISOString())
        .select('id', { count: 'exact' })
      if (count > 0) logger.info(`Cleaned up ${count} expired tracked links`)
    } catch (e) {
      logger.error('Links cleanup cron error:', e.message)
    }
  })

  // ── 9. DATABASE MONITORING — every day at 3am ─────────────
  cron.schedule('0 3 * * *', async () => {
    try {
      const tables = ['messages', 'clients', 'billing', 'otp_codes']
      for (const table of tables) {
        const { count } = await supabase.from(table).select('id', { count: 'exact', head: true })
        logger.info(`DB monitor — ${table}: ${count} rows`)
      }
    } catch (e) {
      logger.error('DB monitoring cron error:', e.message)
    }
  })

  logger.info('✓ All cron jobs started (9 jobs)')
}

module.exports = { startCrons }
