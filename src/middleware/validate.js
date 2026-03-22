// ============================================================
// src/middleware/validate.js
// Input validation for all endpoints using Joi
// Rejects bad input before it reaches your business logic
// ============================================================

const Joi = require('joi')

// Moroccan phone number pattern
const moroccanPhone = Joi.string()
  .pattern(/^(\+212|212|0)[5-7]\d{8}$/)
  .message('Must be a valid Moroccan phone number (+212XXXXXXXXX, 0XXXXXXXXX, or 212XXXXXXXXX)')

// ── VALIDATION SCHEMAS ────────────────────────────────────

const schemas = {

  sendSMS: Joi.object({
    to: moroccanPhone.required(),
    message: Joi.string().trim().min(1).max(160).required(),
    sender_id: Joi.string().alphanum().max(11).optional(),
    message_type: Joi.string().valid('transactional', 'promotional', 'otp').default('transactional')
  }),

  sendBulkSMS: Joi.object({
    recipients: Joi.array()
      .items(moroccanPhone)
      .min(2)
      .max(10000)
      .required(),
    message: Joi.string().trim().min(1).max(160).required(),
    sender_id: Joi.string().alphanum().max(11).optional(),
    schedule_at: Joi.string().isoDate().optional()  // For future scheduling feature
  }),

  registerClient: Joi.object({
    company_name: Joi.string().trim().min(2).max(100).required(),
    email: Joi.string().email().required(),
    phone: moroccanPhone.required(),
    plan: Joi.string().valid('basic', 'standard', 'enterprise').default('basic'),
    webhook_url: Joi.string().uri().optional()
  }),

  updateClient: Joi.object({
    company_name: Joi.string().trim().min(2).max(100).optional(),
    phone: moroccanPhone.optional(),
    webhook_url: Joi.string().uri().allow('').optional(),
    default_sender_id: Joi.string().alphanum().max(11).optional()
  }),

  queryMessages: Joi.object({
    page: Joi.number().integer().min(1).default(1),
    limit: Joi.number().integer().min(1).max(100).default(50),
    status: Joi.string().valid('pending', 'sent', 'delivered', 'failed').optional(),
    start_date: Joi.string().isoDate().optional(),
    end_date: Joi.string().isoDate().optional()
  }),

  addCredits: Joi.object({
    amount: Joi.number().min(10).max(100000).required(),
    payment_reference: Joi.string().required()  // Bank transfer or payment reference
  })
}

// ── VALIDATION MIDDLEWARE FACTORY ─────────────────────────
function validate(schemaName, source = 'body') {
  return (req, res, next) => {
    const schema = schemas[schemaName]
    if (!schema) {
      return next(new Error(`Unknown validation schema: ${schemaName}`))
    }

    const data = source === 'query' ? req.query : source === 'params' ? req.params : req.body

    const { error, value } = schema.validate(data, {
      abortEarly: false,    // Return ALL errors, not just the first
      stripUnknown: true,   // Remove fields not in schema (security)
      convert: true         // Auto-convert types (string '1' → number 1)
    })

    if (error) {
      const errors = error.details.map(d => ({
        field: d.path.join('.'),
        message: d.message.replace(/['"]/g, '')
      }))

      return res.status(400).json({
        error: 'Validation failed',
        code: 'VALIDATION_ERROR',
        errors
      })
    }

    // Replace request data with validated+sanitized version
    if (source === 'query') req.query = value
    else if (source === 'params') req.params = value
    else req.body = value

    next()
  }
}

module.exports = { validate, schemas }
