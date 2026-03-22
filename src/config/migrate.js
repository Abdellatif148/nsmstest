// ============================================================
// src/config/migrate.js
// Database migration system
// Run with: node src/config/migrate.js
//
// WHY YOU NEED THIS:
// When you need to add a new column to your database
// or add a new table in production
// you cannot just delete and recreate the database
// (you would lose all client data)
//
// Migrations track what changes have been applied
// and only apply new ones
// ============================================================

require('dotenv').config()
const { supabase } = require('./database')
const logger = require('./logger')

// ── ALL MIGRATIONS IN ORDER ───────────────────────────────
// Each migration has: id (sequential), name, sql
// Once applied, it is never run again
// NEVER modify a migration after it has been run in production
// ALWAYS add NEW migrations for schema changes

const migrations = [

  // ── 001: Initial schema ───────────────────────────────
  {
    id: 1,
    name: 'initial_schema',
    sql: `
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
        message_type TEXT DEFAULT 'transactional',
        sender_id TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
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

      -- Gateway health log
      CREATE TABLE IF NOT EXISTS gateway_health (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        gateway TEXT NOT NULL,
        status TEXT NOT NULL,
        delivery_rate DECIMAL(5,2),
        error_message TEXT,
        checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      -- API key rotations audit log
      CREATE TABLE IF NOT EXISTS api_key_rotations (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        client_id UUID NOT NULL REFERENCES clients(id),
        old_key_hash TEXT NOT NULL,
        new_key_hash TEXT NOT NULL,
        rotated_by TEXT DEFAULT 'client',
        ip_address TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `
  },

  // ── 002: OTP support ─────────────────────────────────
  {
    id: 2,
    name: 'add_otp_table',
    sql: `
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
    `
  },

  // ── 003: Bulk jobs ────────────────────────────────────
  {
    id: 3,
    name: 'add_bulk_jobs_table',
    sql: `
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
      CREATE INDEX IF NOT EXISTS idx_bulk_jobs_status ON bulk_jobs(status);
    `
  },

  // ── 004: Daily stats ──────────────────────────────────
  {
    id: 4,
    name: 'add_daily_stats_table',
    sql: `
      CREATE TABLE IF NOT EXISTS daily_stats (
        date DATE PRIMARY KEY,
        total_messages INTEGER NOT NULL DEFAULT 0,
        delivered INTEGER NOT NULL DEFAULT 0,
        failed INTEGER NOT NULL DEFAULT 0,
        revenue_dh DECIMAL(10,2) NOT NULL DEFAULT 0,
        delivery_rate DECIMAL(5,2),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `
  },

  // ── 005: Suspension reason column ─────────────────────
  {
    id: 5,
    name: 'add_suspension_reason_to_clients',
    sql: `
      ALTER TABLE clients
      ADD COLUMN IF NOT EXISTS suspension_reason TEXT;
    `
  },

  // ADD NEW MIGRATIONS HERE — never modify existing ones
  // {
  //   id: 6,
  //   name: 'your_migration_name',
  //   sql: `ALTER TABLE ... ;`
  // }
]

// ── MIGRATION RUNNER ──────────────────────────────────────
async function runMigrations() {
  console.log('🔄 Running database migrations...\n')

  // Create migrations tracking table if it doesn't exist
  await supabase.rpc('exec_sql', {
    sql: `
      CREATE TABLE IF NOT EXISTS _migrations (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `
  }).catch(() => {
    // If RPC doesn't work, table might already exist
  })

  // Get already-applied migrations
  const { data: applied } = await supabase
    .from('_migrations')
    .select('id')

  const appliedIds = new Set((applied || []).map(m => m.id))

  // Run pending migrations in order
  let appliedCount = 0

  for (const migration of migrations) {
    if (appliedIds.has(migration.id)) {
      console.log(`  ✓ Migration ${migration.id}: ${migration.name} (already applied)`)
      continue
    }

    console.log(`  → Applying migration ${migration.id}: ${migration.name}...`)

    try {
      // Execute migration SQL
      const { error } = await supabase.rpc('exec_sql', { sql: migration.sql })

      if (error) throw error

      // Record as applied
      await supabase.from('_migrations').insert({
        id: migration.id,
        name: migration.name
      })

      console.log(`  ✅ Migration ${migration.id}: ${migration.name} applied`)
      appliedCount++

    } catch (err) {
      console.error(`  ❌ Migration ${migration.id} FAILED:`, err.message)
      console.error('  Stopping migrations — fix the error before continuing')
      process.exit(1)
    }
  }

  if (appliedCount === 0) {
    console.log('\n✅ Database is up to date. No migrations needed.')
  } else {
    console.log(`\n✅ Applied ${appliedCount} migration(s) successfully.`)
  }
}

// Run if called directly: node src/config/migrate.js
if (require.main === module) {
  runMigrations()
    .then(() => process.exit(0))
    .catch(err => {
      console.error('Migration failed:', err)
      process.exit(1)
    })
}

module.exports = { runMigrations }
