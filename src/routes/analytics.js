// ============================================================
// src/routes/analytics.js — Production analytics
// Real queries against Supabase — not in-memory aggregation
// ============================================================

const express = require('express')
const router = express.Router()
const { authenticateApiKey } = require('../middleware/auth')
const { supabase } = require('../config/database')

router.use(authenticateApiKey)

// ── GET /overview ─────────────────────────────────────────
router.get('/overview', async (req, res) => {
  try {
    const clientId = req.client.id
    const now = new Date()
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString()
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString()

    // Run all queries in parallel — faster than sequential
    const [allTime, today, thisMonth, byNetwork, recentFailures] = await Promise.all([

      // All time stats
      supabase
        .from('messages')
        .select('status', { count: 'exact' })
        .eq('client_id', clientId),

      // Today
      supabase
        .from('messages')
        .select('status, cost')
        .eq('client_id', clientId)
        .gte('created_at', todayStart),

      // This month
      supabase
        .from('messages')
        .select('status, cost')
        .eq('client_id', clientId)
        .gte('created_at', monthStart),

      // By network
      supabase
        .from('messages')
        .select('network, status')
        .eq('client_id', clientId)
        .gte('created_at', monthStart),

      // Recent failures for diagnostics
      supabase
        .from('messages')
        .select('to_number, failure_reason, created_at')
        .eq('client_id', clientId)
        .eq('status', 'failed')
        .order('created_at', { ascending: false })
        .limit(5)
    ])

    // Process all-time stats
    const allMessages = allTime.data || []
    const totalSent = allMessages.length
    const totalDelivered = allMessages.filter(m => m.status === 'delivered').length
    const totalFailed = allMessages.filter(m => m.status === 'failed').length
    const overallDeliveryRate = totalSent > 0
      ? ((totalDelivered / totalSent) * 100).toFixed(1)
      : '0.0'

    // Process today
    const todayMessages = today.data || []
    const todayCost = todayMessages.reduce((sum, m) => sum + (parseFloat(m.cost) || 0), 0)

    // Process month
    const monthMessages = thisMonth.data || []
    const monthCost = monthMessages.reduce((sum, m) => sum + (parseFloat(m.cost) || 0), 0)
    const monthDelivered = monthMessages.filter(m => m.status === 'delivered').length
    const monthDeliveryRate = monthMessages.length > 0
      ? ((monthDelivered / monthMessages.length) * 100).toFixed(1)
      : '0.0'

    // Process by network
    const networkStats = {}
    ;(byNetwork.data || []).forEach(m => {
      if (!networkStats[m.network]) {
        networkStats[m.network] = { sent: 0, delivered: 0, failed: 0 }
      }
      networkStats[m.network].sent++
      if (m.status === 'delivered') networkStats[m.network].delivered++
      if (m.status === 'failed') networkStats[m.network].failed++
    })

    Object.keys(networkStats).forEach(net => {
      const n = networkStats[net]
      n.delivery_rate = n.sent > 0
        ? ((n.delivered / n.sent) * 100).toFixed(1) + '%'
        : '0%'
    })

    return res.json({
      account: {
        name: req.client.name,
        plan: req.client.plan,
        credits_remaining: req.client.credits,
        currency: 'DH'
      },
      all_time: {
        total_messages: totalSent,
        delivered: totalDelivered,
        failed: totalFailed,
        delivery_rate: overallDeliveryRate + '%'
      },
      today: {
        sent: todayMessages.length,
        cost_dh: todayCost.toFixed(2)
      },
      this_month: {
        sent: monthMessages.length,
        delivered: monthDelivered,
        delivery_rate: monthDeliveryRate + '%',
        cost_dh: monthCost.toFixed(2)
      },
      by_network: networkStats,
      recent_failures: (recentFailures.data || []).map(f => ({
        phone: f.to_number.substring(0, 6) + '****',  // Mask for privacy
        reason: f.failure_reason,
        time: f.created_at
      })),
      generated_at: new Date().toISOString()
    })

  } catch (err) {
    return res.status(500).json({ error: 'Failed to generate analytics' })
  }
})

// ── GET /usage?period=7d ──────────────────────────────────
router.get('/usage', async (req, res) => {
  try {
    const days = req.query.period === '30d' ? 30 : 7
    const startDate = new Date()
    startDate.setDate(startDate.getDate() - days)

    const { data } = await supabase
      .from('messages')
      .select('status, cost, created_at')
      .eq('client_id', req.client.id)
      .gte('created_at', startDate.toISOString())
      .order('created_at', { ascending: true })

    // Group by day
    const dailyMap = {}
    ;(data || []).forEach(msg => {
      const day = msg.created_at.split('T')[0]
      if (!dailyMap[day]) {
        dailyMap[day] = { date: day, sent: 0, delivered: 0, failed: 0, cost_dh: 0 }
      }
      dailyMap[day].sent++
      if (msg.status === 'delivered') dailyMap[day].delivered++
      if (msg.status === 'failed') dailyMap[day].failed++
      dailyMap[day].cost_dh += parseFloat(msg.cost) || 0
    })

    // Fill missing days with zeros
    for (let i = 0; i < days; i++) {
      const d = new Date()
      d.setDate(d.getDate() - i)
      const dayStr = d.toISOString().split('T')[0]
      if (!dailyMap[dayStr]) {
        dailyMap[dayStr] = { date: dayStr, sent: 0, delivered: 0, failed: 0, cost_dh: 0 }
      }
    }

    const sorted = Object.values(dailyMap)
      .sort((a, b) => a.date.localeCompare(b.date))
      .map(d => ({ ...d, cost_dh: parseFloat(d.cost_dh.toFixed(2)) }))

    return res.json({ period: req.query.period || '7d', data: sorted })

  } catch (err) {
    return res.status(500).json({ error: 'Failed to get usage data' })
  }
})

// ── GET /best-times ───────────────────────────────────────
router.get('/best-times', async (req, res) => {
  try {
    const startDate = new Date()
    startDate.setDate(startDate.getDate() - 30)

    const { data } = await supabase
      .from('messages')
      .select('status, created_at')
      .eq('client_id', req.client.id)
      .gte('created_at', startDate.toISOString())

    const byHour = {}
    for (let h = 0; h < 24; h++) {
      byHour[h] = { hour: h, label: `${String(h).padStart(2,'0')}:00`, sent: 0, delivered: 0 }
    }

    ;(data || []).forEach(msg => {
      const hour = new Date(msg.created_at).getHours()
      byHour[hour].sent++
      if (msg.status === 'delivered') byHour[hour].delivered++
    })

    const result = Object.values(byHour).map(h => ({
      ...h,
      delivery_rate: h.sent > 0 ? parseFloat(((h.delivered / h.sent) * 100).toFixed(1)) : null
    }))

    const best = result
      .filter(h => h.sent >= 5)
      .sort((a, b) => b.delivery_rate - a.delivery_rate)
      .slice(0, 3)

    return res.json({
      all_hours: result,
      best_hours: best,
      based_on: `Last 30 days of your actual data`
    })

  } catch (err) {
    return res.status(500).json({ error: 'Failed to calculate best times' })
  }
})

module.exports = router
