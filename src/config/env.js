// ============================================================
// src/config/env.js
// PRODUCTION REQUIREMENT: Validate ALL environment variables
// at startup. If anything is missing → crash immediately.
// Better to crash at startup than fail silently in production.
// ============================================================

const Joi = require('joi')

const envSchema = Joi.object({
  // Server
  NODE_ENV: Joi.string().valid('development', 'production', 'test').required(),
  PORT: Joi.number().default(3000),
  API_VERSION: Joi.string().default('v1'),

  // In the Joi schema in src/config/env.js, add:
  RESEND_API_KEY: Joi.string().required(),
  EMAIL_FROM: Joi.string().default('Nook SMS <noreply@nook.ma>'),


  // Security — required in production
  JWT_SECRET: Joi.string().min(32).required(),
  WEBHOOK_SECRET: Joi.string().min(16).required(),
  ADMIN_API_KEY: Joi.string().min(16).required(),

  // Supabase — required
  SUPABASE_URL: Joi.string().uri().required(),
  SUPABASE_SERVICE_KEY: Joi.string().required(),
  SUPABASE_ANON_KEY: Joi.string().required(),

  // SMS Gateways — at least Africa's Talking required
  AT_API_KEY: Joi.string().required(),
  AT_USERNAME: Joi.string().required(),
  AT_SENDER_ID: Joi.string().allow('').default(''),

  // Fallback gateways — optional
  VONAGE_API_KEY: Joi.string().allow('').optional(),
  VONAGE_API_SECRET: Joi.string().allow('').optional(),
  VONAGE_FROM: Joi.string().default('NOOK'),

  INFOBIP_API_KEY: Joi.string().allow('').optional(),
  INFOBIP_BASE_URL: Joi.string().uri().allow('').optional(),

  // Redis — required for queue
  REDIS_URL: Joi.string().default('redis://localhost:6379'),

  // Rate limiting
  RATE_LIMIT_WINDOW_MS: Joi.number().default(60000),
  RATE_LIMIT_MAX_REQUESTS: Joi.number().default(100),

  // Logging
  LOG_LEVEL: Joi.string().valid('error', 'warn', 'info', 'debug').default('info'),
  LOG_DIR: Joi.string().default('./logs'),

  // CORS
  ALLOWED_ORIGINS: Joi.string().default('http://localhost:3000'),

  // Pricing
  PRICE_MAROC_TELECOM: Joi.number().default(0.20),
  PRICE_ORANGE: Joi.number().default(0.20),
  PRICE_INWI: Joi.number().default(0.20),
  PRICE_UNKNOWN: Joi.number().default(0.25),

  COST_AT: Joi.number().default(0.07),
  COST_VONAGE: Joi.number().default(0.09),
  COST_INFOBIP: Joi.number().default(0.08),

}).unknown(true)  // Allow extra env vars (from OS, Docker, etc.)

const { error, value } = envSchema.validate(process.env)

if (error) {
  console.error('❌ FATAL: Invalid environment configuration')
  console.error('Missing or invalid variables:')
  error.details.forEach(detail => {
    console.error(`  → ${detail.message}`)
  })
  console.error('\nCopy .env.example to .env and fill all required values')
  process.exit(1)  // Hard crash — do not start with bad config
}

module.exports = {
  server: {
    env: value.NODE_ENV,
    port: value.PORT,
    version: value.API_VERSION,
    isDev: value.NODE_ENV === 'development',
    isProd: value.NODE_ENV === 'production',
    isTest: value.NODE_ENV === 'test',
  },
  security: {
    jwtSecret: value.JWT_SECRET,
    webhookSecret: value.WEBHOOK_SECRET,
    adminApiKey: value.ADMIN_API_KEY,
  },
  supabase: {
    url: value.SUPABASE_URL,
    serviceKey: value.SUPABASE_SERVICE_KEY,
    anonKey: value.SUPABASE_ANON_KEY,
  },
  gateways: {
    africastalking: {
      apiKey: value.AT_API_KEY,
      username: value.AT_USERNAME,
      senderId: value.AT_SENDER_ID,
      cost: value.COST_AT,
    },
    vonage: {
      apiKey: value.VONAGE_API_KEY,
      apiSecret: value.VONAGE_API_SECRET,
      from: value.VONAGE_FROM,
      cost: value.COST_VONAGE,
      enabled: !!value.VONAGE_API_KEY,
    },
    infobip: {
      apiKey: value.INFOBIP_API_KEY,
      baseUrl: value.INFOBIP_BASE_URL,
      cost: value.COST_INFOBIP,
      enabled: !!value.INFOBIP_API_KEY,
    }
  },
  redis: {
    url: value.REDIS_URL,
  },
  rateLimit: {
    windowMs: value.RATE_LIMIT_WINDOW_MS,
    max: value.RATE_LIMIT_MAX_REQUESTS,
  },
  logging: {
    level: value.LOG_LEVEL,
    dir: value.LOG_DIR,
  },
  cors: {
    origins: value.ALLOWED_ORIGINS.split(',').map(o => o.trim()),
  },
  pricing: {
    maroc_telecom: value.PRICE_MAROC_TELECOM,
    orange: value.PRICE_ORANGE,
    inwi: value.PRICE_INWI,
    unknown: value.PRICE_UNKNOWN,
  }
}

