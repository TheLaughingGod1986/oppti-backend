-- Fresh-Stack v2.0 - Initial Schema
-- Run this in Supabase SQL Editor

-- 1. Licenses table (core)
-- Note: Table may already exist, so we add missing columns if needed
CREATE TABLE IF NOT EXISTS licenses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  license_key VARCHAR(255) UNIQUE NOT NULL DEFAULT gen_random_uuid()::text,

  -- Owner info
  email VARCHAR(255) UNIQUE,
  password_hash VARCHAR(255),

  -- Plan info
  plan VARCHAR(50) NOT NULL DEFAULT 'free',
  status VARCHAR(50) NOT NULL DEFAULT 'active',

  -- Billing
  billing_anchor_date TIMESTAMPTZ DEFAULT NOW(),
  billing_cycle VARCHAR(50) DEFAULT 'monthly',

  -- Limits
  max_sites INTEGER DEFAULT 1,

  -- Metadata
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ
);

-- Add missing columns if they don't exist (for existing tables)
DO $$
BEGIN
  -- Add stripe_customer_id if missing
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                 WHERE table_name = 'licenses' AND column_name = 'stripe_customer_id') THEN
    ALTER TABLE licenses ADD COLUMN stripe_customer_id VARCHAR(255);
  END IF;

  -- Add stripe_subscription_id if missing
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                 WHERE table_name = 'licenses' AND column_name = 'stripe_subscription_id') THEN
    ALTER TABLE licenses ADD COLUMN stripe_subscription_id VARCHAR(255);
  END IF;
END $$;

-- Create indexes (only if columns exist)
CREATE INDEX IF NOT EXISTS idx_licenses_license_key ON licenses(license_key);
CREATE INDEX IF NOT EXISTS idx_licenses_email ON licenses(email) WHERE email IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_licenses_status ON licenses(status);

-- Create stripe_customer index only if column exists
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns 
             WHERE table_name = 'licenses' AND column_name = 'stripe_customer_id') THEN
    CREATE INDEX IF NOT EXISTS idx_licenses_stripe_customer ON licenses(stripe_customer_id) WHERE stripe_customer_id IS NOT NULL;
  END IF;
END $$;

-- 2. Sites table
CREATE TABLE IF NOT EXISTS sites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  license_key VARCHAR(255) NOT NULL REFERENCES licenses(license_key) ON DELETE CASCADE,

  -- Site identification
  site_hash VARCHAR(255) UNIQUE NOT NULL,
  site_url VARCHAR(500) NOT NULL,
  site_name VARCHAR(255),
  fingerprint VARCHAR(255),

  -- Agency quota limits
  quota_limit INTEGER,

  -- Status
  status VARCHAR(50) NOT NULL DEFAULT 'active',

  -- Metadata
  activated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_activity_at TIMESTAMPTZ,
  deactivated_at TIMESTAMPTZ,

  CONSTRAINT chk_site_status CHECK (status IN ('active', 'deactivated'))
);

CREATE INDEX IF NOT EXISTS idx_sites_license_key ON sites(license_key);
CREATE INDEX IF NOT EXISTS idx_sites_site_hash ON sites(site_hash);
CREATE INDEX IF NOT EXISTS idx_sites_status ON sites(status);

-- 3. Usage logs table
CREATE TABLE IF NOT EXISTS usage_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- License & Site
  license_key VARCHAR(255) NOT NULL REFERENCES licenses(license_key) ON DELETE CASCADE,
  site_hash VARCHAR(255) NOT NULL,

  -- User tracking
  user_id VARCHAR(100),
  user_email VARCHAR(255),

  -- Image details
  image_url TEXT,
  image_filename VARCHAR(500),

  -- Usage
  credits_used INTEGER NOT NULL DEFAULT 1,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  total_tokens INTEGER,

  -- Request metadata
  cached BOOLEAN DEFAULT FALSE,
  model_used VARCHAR(100) DEFAULT 'gpt-4o-mini',
  generation_time_ms INTEGER,

  -- Timestamp
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_usage_logs_license_key ON usage_logs(license_key);
CREATE INDEX IF NOT EXISTS idx_usage_logs_site_hash ON usage_logs(site_hash);
CREATE INDEX IF NOT EXISTS idx_usage_logs_created_at ON usage_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_usage_logs_user_email ON usage_logs(user_email);
CREATE INDEX IF NOT EXISTS idx_usage_logs_license_created ON usage_logs(license_key, created_at);

-- 4. Quota summaries table (for fast lookups)
CREATE TABLE IF NOT EXISTS quota_summaries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  license_key VARCHAR(255) NOT NULL REFERENCES licenses(license_key) ON DELETE CASCADE,

  -- Billing period
  period_start TIMESTAMPTZ NOT NULL,
  period_end TIMESTAMPTZ NOT NULL,

  -- Aggregated usage
  total_credits_used INTEGER NOT NULL DEFAULT 0,
  total_limit INTEGER NOT NULL,

  -- Per-site breakdown (JSON for agency plans)
  site_usage JSONB,

  -- Metadata
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT uq_license_period UNIQUE (license_key, period_start)
);

CREATE INDEX IF NOT EXISTS idx_quota_summaries_license_period ON quota_summaries(license_key, period_start);

-- 5. Debug logs table
CREATE TABLE IF NOT EXISTS debug_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Context
  license_key VARCHAR(255) REFERENCES licenses(license_key) ON DELETE SET NULL,
  site_hash VARCHAR(255),
  user_email VARCHAR(255),

  -- Log details
  level VARCHAR(50) NOT NULL,
  message TEXT NOT NULL,
  error_code VARCHAR(100),
  stack_trace TEXT,

  -- Request context
  request_id UUID,
  endpoint VARCHAR(255),
  http_method VARCHAR(10),
  http_status INTEGER,

  -- Metadata
  metadata JSONB,

  -- Timestamp
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT chk_log_level CHECK (level IN ('error', 'warn', 'info', 'debug'))
);

CREATE INDEX IF NOT EXISTS idx_debug_logs_license ON debug_logs(license_key);
CREATE INDEX IF NOT EXISTS idx_debug_logs_created_at ON debug_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_debug_logs_level ON debug_logs(level);

-- Success message
DO $$
BEGIN
  RAISE NOTICE '✅ All tables created successfully!';
  RAISE NOTICE '📋 Next step: Run node setup-test-license.js to create a test license';
END $$;
