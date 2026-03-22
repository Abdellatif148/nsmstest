-- ============================================================
-- COMPLETE DATABASE SCHEMA — Run in Supabase SQL Editor
-- Copy all of this and run it once on a new project
-- ============================================================

-- Clients table
CREATE TABLE IF NOT EXISTS clients (
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
  webhook_secret TEXT,
  suspension_reason TEXT,
  monthly_limit INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_clients_api_key ON clients(api_key);
CREATE INDEX IF NOT EXISTS idx_clients_email ON clients(email);
CREATE INDEX IF NOT EXISTS idx_clients_status ON clients(status);

-- Messages table
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  client_id UUID NOT NULL REFERENCES clients(id),
  to_number TEXT NOT NULL,
  message TEXT NOT NULL,
  message_length INTEGER,
  network TEXT,
  message_type TEXT DEFAULT 'transactional' CHECK (message_type IN ('transactional', 'promotional', 'otp')),
  sender_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'delivered', 'failed', 'rejected')),
  gateway TEXT NOT NULL DEFAULT 'africastalking',
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

CREATE INDEX IF NOT EXISTS idx_messages_client_id ON messages(client_id);
CREATE INDEX IF NOT EXISTS idx_messages_status ON messages(status);
CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);
CREATE INDEX IF NOT EXISTS idx_messages_gateway_message_id ON messages(gateway_message_id);
CREATE INDEX IF NOT EXISTS idx_messages_to_number ON messages(to_number);

-- Billing transactions
CREATE TABLE IF NOT EXISTS billing_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES clients(id),
  type TEXT NOT NULL CHECK (type IN ('credit_purchase', 'sms_charge', 'refund', 'bonus')),
  amount DECIMAL(10,2) NOT NULL,
  balance_before DECIMAL(10,2) NOT NULL,
  balance_after DECIMAL(10,2) NOT NULL,
  description TEXT,
  message_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_billing_client_id ON billing_transactions(client_id);
CREATE INDEX IF NOT EXISTS idx_billing_created_at ON billing_transactions(created_at);

-- OTPs table
CREATE TABLE IF NOT EXISTS otps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES clients(id),
  phone TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  purpose TEXT NOT NULL DEFAULT 'verification',
  attempts INTEGER NOT NULL DEFAULT 0,
  used BOOLEAN NOT NULL DEFAULT false,
  used_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_otps_client_phone ON otps(client_id, phone);
CREATE INDEX IF NOT EXISTS idx_otps_expires_at ON otps(expires_at);

-- Bulk jobs table
CREATE TABLE IF NOT EXISTS bulk_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES clients(id),
  total INTEGER NOT NULL,
  sent INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  progress INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'queued',
  message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bulk_jobs_client_id ON bulk_jobs(client_id);

-- Gateway health log
CREATE TABLE IF NOT EXISTS gateway_health (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  gateway TEXT NOT NULL,
  status TEXT NOT NULL,
  delivery_rate DECIMAL(5,2),
  error_message TEXT,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- API key rotation audit log
CREATE TABLE IF NOT EXISTS api_key_rotations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES clients(id),
  old_key_hash TEXT NOT NULL,
  new_key_hash TEXT NOT NULL,
  rotated_by TEXT DEFAULT 'client',
  ip_address TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Daily stats summary
CREATE TABLE IF NOT EXISTS daily_stats (
  date DATE PRIMARY KEY,
  total_messages INTEGER NOT NULL DEFAULT 0,
  delivered INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  revenue_dh DECIMAL(10,2) NOT NULL DEFAULT 0,
  delivery_rate DECIMAL(5,2),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Migrations tracking
CREATE TABLE IF NOT EXISTS _migrations (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Auto-update updated_at trigger
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER IF NOT EXISTS update_clients_updated_at
  BEFORE UPDATE ON clients
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER IF NOT EXISTS update_messages_updated_at
  BEFORE UPDATE ON messages
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Row Level Security (protect data at database level)
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE otps ENABLE ROW LEVEL SECURITY;
ALTER TABLE bulk_jobs ENABLE ROW LEVEL SECURITY;
