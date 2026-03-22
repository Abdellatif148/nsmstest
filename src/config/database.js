// ============================================================
// src/config/database.js
// Supabase client — your production database
// All data persists here. Never in memory.
// ============================================================

const { createClient } = require('@supabase/supabase-js')
const config = require('./env')
const logger = require('./logger')

// Service role client — has full database access
// Used for backend operations (writing, reading all data)
const supabase = createClient(
  config.supabase.url,
  config.supabase.serviceKey,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  }
)

// Test connection on startup
async function testConnection() {
  try {
    const { error } = await supabase.from('clients').select('id').limit(1)
    if (error && error.code !== 'PGRST116') {  // PGRST116 = table empty, that is OK
      throw error
    }
    logger.info('✅ Database connected successfully')
  } catch (err) {
    logger.error('❌ Database connection failed', { error: err.message })
    if (config.server.isProd) {
      process.exit(1)  // Cannot run in production without database
    }
  }
}

module.exports = { supabase, testConnection }


// ============================================================
// SUPABASE DATABASE SCHEMA
// Run this SQL in your Supabase SQL Editor to create all tables
// ============================================================

/*

-- ── CLIENTS TABLE ────────────────────────────────────────
CREATE TABLE clients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  phone TEXT NOT NULL,
  company TEXT,
  plan TEXT NOT NULL DEFAULT 'basic' CHECK (plan IN ('basic', 'standard', 'enterprise')),
  api_key TEXT UNIQUE NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'pending')),
  credits DECIMAL(10,2) NOT NULL DEFAULT 50.00,
  default_sender_id TEXT DEFAULT 'NOOK',
  webhook_url TEXT,
  monthly_limit INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_clients_api_key ON clients(api_key);
CREATE INDEX idx_clients_email ON clients(email);
CREATE INDEX idx_clients_status ON clients(status);

-- ── MESSAGES TABLE ────────────────────────────────────────
CREATE TABLE messages (
  id TEXT PRIMARY KEY,  -- Our format: nk_[20chars]
  client_id UUID NOT NULL REFERENCES clients(id),
  to_number TEXT NOT NULL,
  message TEXT NOT NULL,
  message_length INTEGER,
  network TEXT,
  message_type TEXT DEFAULT 'transactional' CHECK (message_type IN ('transactional', 'promotional', 'otp')),
  sender_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'delivered', 'failed', 'rejected')),
  gateway TEXT NOT NULL DEFAULT 'africastalking' CHECK (gateway IN ('africastalking', 'vonage', 'infobip')),
  gateway_message_id TEXT,
  gateway_status TEXT,
  cost DECIMAL(6,4),
  error_code TEXT,
  failure_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_messages_client_id ON messages(client_id);
CREATE INDEX idx_messages_status ON messages(status);
CREATE INDEX idx_messages_created_at ON messages(created_at);
CREATE INDEX idx_messages_gateway_message_id ON messages(gateway_message_id);
CREATE INDEX idx_messages_to_number ON messages(to_number);

-- ── BILLING TRANSACTIONS ──────────────────────────────────
CREATE TABLE billing_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES clients(id),
  type TEXT NOT NULL CHECK (type IN ('credit_purchase', 'sms_charge', 'refund', 'bonus')),
  amount DECIMAL(10,2) NOT NULL,
  balance_before DECIMAL(10,2) NOT NULL,
  balance_after DECIMAL(10,2) NOT NULL,
  description TEXT,
  message_id TEXT REFERENCES messages(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_billing_client_id ON billing_transactions(client_id);
CREATE INDEX idx_billing_created_at ON billing_transactions(created_at);

-- ── API KEY ROTATION LOG ──────────────────────────────────
CREATE TABLE api_key_rotations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES clients(id),
  old_key_hash TEXT NOT NULL,
  new_key_hash TEXT NOT NULL,
  rotated_by TEXT DEFAULT 'client',
  ip_address TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── GATEWAY HEALTH LOG ────────────────────────────────────
CREATE TABLE gateway_health (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  gateway TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('healthy', 'degraded', 'down')),
  delivery_rate DECIMAL(5,2),
  avg_delivery_seconds DECIMAL(8,2),
  error_message TEXT,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── AUTOMATIC UPDATED_AT TRIGGER ─────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_clients_updated_at
  BEFORE UPDATE ON clients
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER update_messages_updated_at
  BEFORE UPDATE ON messages
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ── ROW LEVEL SECURITY ────────────────────────────────────
-- Clients can only see their own data
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_transactions ENABLE ROW LEVEL SECURITY;

-- Your backend uses service role which bypasses RLS
-- This protects against direct database access attempts

*/
