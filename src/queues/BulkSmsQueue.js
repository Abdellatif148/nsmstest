// ============================================================
// src/queues/BulkSmsQueue.js
// Bull queue for processing bulk SMS
// Why queue? Sending 10,000 SMS cannot happen in one HTTP request
// Queue processes them in background — client gets job ID immediately
// ============================================================

const Bull = require('bull')
const config = require('../config/env')
const { sendSMS } = require('../services/SmsService')
const { supabase } = require('../config/database')
const logger = require('../config/logger')

// Create the queue connected to Redis
const bulkSmsQueue = new Bull('bulk-sms', {
  redis: config.redis.url,
  defaultJobOptions: {
    attempts: 3,           // Retry failed jobs 3 times
    backoff: {
      type: 'exponential', // Wait longer between retries
      delay: 5000          // Start with 5 second delay
    },
    removeOnComplete: 100, // Keep last 100 completed jobs in Redis
    removeOnFail: 200,     // Keep last 200 failed jobs for debugging
  }
})

// ── PROCESS JOBS ─────────────────────────────────────────
// This runs in the background — not blocking HTTP requests
bulkSmsQueue.process('send-bulk', 5, async (job) => {
  // 5 = process 5 jobs concurrently
  const { recipients, message, clientId, client, senderId, jobId } = job.data

  const results = {
    total: recipients.length,
    sent: 0,
    failed: 0,
    errors: []
  }

  // Process in small batches to be respectful to gateway
  const batchSize = 20

  for (let i = 0; i < recipients.length; i += batchSize) {
    const batch = recipients.slice(i, i + batchSize)

    // Process batch in parallel
    const batchResults = await Promise.allSettled(
      batch.map(phone => sendSMS({
        to: phone,
        message,
        clientId,
        client,
        senderId,
        messageType: 'promotional'
      }))
    )

    batchResults.forEach((result, idx) => {
      if (result.status === 'fulfilled') {
        results.sent++
      } else {
        results.failed++
        results.errors.push({
          phone: batch[idx],
          error: result.reason.message
        })
      }
    })

    // Update job progress
    const progress = Math.round(((i + batchSize) / recipients.length) * 100)
    await job.progress(Math.min(progress, 100))

    // Update job status in database
    await supabase
      .from('bulk_jobs')
      .update({
        sent: results.sent,
        failed: results.failed,
        progress: Math.min(progress, 100),
        updated_at: new Date().toISOString()
      })
      .eq('id', jobId)

    // Small delay between batches
    if (i + batchSize < recipients.length) {
      await new Promise(resolve => setTimeout(resolve, 200))
    }
  }

  // Mark job complete
  await supabase
    .from('bulk_jobs')
    .update({
      status: 'completed',
      sent: results.sent,
      failed: results.failed,
      progress: 100,
      completed_at: new Date().toISOString()
    })
    .eq('id', jobId)

  logger.sms('BULK_COMPLETE', {
    jobId,
    clientId,
    total: results.total,
    sent: results.sent,
    failed: results.failed
  })

  return results
})

// ── EVENT HANDLERS ────────────────────────────────────────
bulkSmsQueue.on('completed', (job, result) => {
  logger.info(`Bulk job ${job.id} completed`, result)
})

bulkSmsQueue.on('failed', (job, err) => {
  logger.error(`Bulk job ${job.id} failed`, { error: err.message })
})

bulkSmsQueue.on('stalled', (job) => {
  logger.warn(`Bulk job ${job.id} stalled — will retry`)
})

// ── ADD JOB TO QUEUE ─────────────────────────────────────
async function addBulkJob(data) {
  const job = await bulkSmsQueue.add('send-bulk', data, {
    priority: data.client.plan === 'enterprise' ? 1 : 5
    // Enterprise clients get higher priority queue processing
  })

  return job.id
}

// ── GET JOB STATUS ───────────────────────────────────────
async function getJobStatus(jobId) {
  const job = await bulkSmsQueue.getJob(jobId)
  if (!job) return null

  return {
    id: job.id,
    status: await job.getState(),
    progress: job._progress,
    data: {
      total: job.data.recipients.length,
    },
    createdAt: new Date(job.timestamp).toISOString(),
    processedAt: job.processedOn ? new Date(job.processedOn).toISOString() : null,
    completedAt: job.finishedOn ? new Date(job.finishedOn).toISOString() : null,
  }
}

module.exports = { bulkSmsQueue, addBulkJob, getJobStatus }
