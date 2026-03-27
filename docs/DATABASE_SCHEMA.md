# Fresh-Stack Database Schema

**Version:** 2.0
**Database:** PostgreSQL (via Supabase)
**Last Updated:** 2025-12-11

---

## Overview

This schema supports:
- ✅ License-based authentication (no complex JWT/organizations)
- ✅ Multi-user per site (Pro/Agency)
- ✅ Multi-site per license (Agency only)
- ✅ Per-user usage tracking
- ✅ Per-site quota limits (Agency)
- ✅ Billing anchor dates (custom reset dates)
- ✅ One-time credit purchases
- ✅ Stripe subscription webhooks

---

## Tables

### 1. `licenses`

Core license records. One license = one account.

```sql
CREATE TABLE licenses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  license_key UUID UNIQUE NOT NULL DEFAULT gen_random_uuid(),

  -- Owner info (for dashboard login)
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255), -- bcrypt hash (null if not set yet)

  -- Plan info
  plan VARCHAR(50) NOT NULL DEFAULT 'free', -- authoritative plan used by runtime
  status VARCHAR(50) NOT NULL DEFAULT 'active', -- 'active', 'expired', 'suspended', 'cancelled'

  -- Billing
  stripe_customer_id VARCHAR(255),
  stripe_subscription_id VARCHAR(255),
  billing_anchor_date TIMESTAMPTZ NOT NULL DEFAULT NOW(), -- Custom reset date
  billing_cycle VARCHAR(50) DEFAULT 'monthly', -- 'monthly', 'annual'

  -- Limits
  max_sites INTEGER NOT NULL DEFAULT 1, -- 1 for free/pro, NULL for unlimited (agency)

  -- Metadata
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ, -- NULL for perpetual licenses

  -- Indexes
  CONSTRAINT chk_plan CHECK (plan IN ('free', 'pro', 'agency')),
  CONSTRAINT chk_status CHECK (status IN ('active', 'expired', 'suspended', 'cancelled'))
);

CREATE INDEX idx_licenses_license_key ON licenses(license_key);
CREATE INDEX idx_licenses_email ON licenses(email);
CREATE INDEX idx_licenses_stripe_customer ON licenses(stripe_customer_id);
CREATE INDEX idx_licenses_status ON licenses(status);
```

**Notes:**
- `license_key` is the UUID used by WordPress plugin
- `email` is used for dashboard login
- `billing_anchor_date` determines when quota resets (e.g., 15th of each month)
- `max_sites` is 1 for free/pro, NULL for unlimited agency sites

---

### 2. `sites`

Activated sites under a license.

```sql
CREATE TABLE sites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  license_key UUID NOT NULL REFERENCES licenses(license_key) ON DELETE CASCADE,

  -- Site identification
  site_hash VARCHAR(255) UNIQUE NOT NULL, -- MD5 hash sent by plugin (X-Site-Key)
  site_url VARCHAR(500) NOT NULL,
  site_name VARCHAR(255),
  fingerprint VARCHAR(255), -- SHA256 hash for site verification

  -- Agency-specific quota limits
  quota_limit INTEGER, -- NULL = use license default, set value = custom limit

  -- Status
  status VARCHAR(50) NOT NULL DEFAULT 'active', -- 'active', 'deactivated'

  -- Metadata
  activated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_activity_at TIMESTAMPTZ,
  deactivated_at TIMESTAMPTZ,

  CONSTRAINT chk_site_status CHECK (status IN ('active', 'deactivated'))
);

CREATE INDEX idx_sites_license_key ON sites(license_key);
CREATE INDEX idx_sites_site_hash ON sites(site_hash);
CREATE INDEX idx_sites_status ON sites(status);
```

**Notes:**
- `site_hash` is the unique identifier sent by plugin (`X-Site-Key` header)
- `quota_limit` only applies to agency plans (per-site caps)
- One license can have multiple sites (agency), or just one site (free/pro)

---

### 3. `usage_logs`

Detailed logs of every alt text generation.

```sql
CREATE TABLE usage_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- License & Site
  license_key UUID NOT NULL REFERENCES licenses(license_key) ON DELETE CASCADE,
  site_hash VARCHAR(255) NOT NULL,

  -- User tracking (from WordPress)
  user_id VARCHAR(100), -- WordPress user ID (e.g., "5", "12")
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
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Indexes for fast queries
  CONSTRAINT fk_site FOREIGN KEY (site_hash) REFERENCES sites(site_hash) ON DELETE CASCADE
);

CREATE INDEX idx_usage_logs_license_key ON usage_logs(license_key);
CREATE INDEX idx_usage_logs_site_hash ON usage_logs(site_hash);
CREATE INDEX idx_usage_logs_created_at ON usage_logs(created_at);
CREATE INDEX idx_usage_logs_user_email ON usage_logs(user_email);
CREATE INDEX idx_usage_logs_license_created ON usage_logs(license_key, created_at);
```

**Notes:**
- Every generation is logged (even cached ones, with `cached=true`)
- `user_id` and `user_email` come from plugin headers (`X-WP-User-ID`, `X-WP-User-Email`)
- `credits_used` is typically 1 per image, but could be more for complex operations
- Partitioning by `created_at` recommended for high-volume installations

---

### 4. `quota_summaries`

Pre-aggregated quota data for fast lookups (updated by trigger).

```sql
CREATE TABLE quota_summaries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  license_key UUID NOT NULL REFERENCES licenses(license_key) ON DELETE CASCADE,

  -- Billing period
  period_start TIMESTAMPTZ NOT NULL,
  period_end TIMESTAMPTZ NOT NULL,

  -- Aggregated usage
  total_credits_used INTEGER NOT NULL DEFAULT 0,
  total_limit INTEGER NOT NULL,

  -- Per-site breakdown (JSON for agency plans)
  site_usage JSONB, -- { "site_hash_1": 234, "site_hash_2": 567 }

  -- Metadata
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT uq_license_period UNIQUE (license_key, period_start)
);

CREATE INDEX idx_quota_summaries_license_period ON quota_summaries(license_key, period_start);
```

**Notes:**
- One row per license per billing period
- Automatically updated by trigger when `usage_logs` inserted
- `site_usage` JSON stores per-site usage for agency plans
- Enables fast `/usage` endpoint responses (no aggregation needed)

---

### 5. `subscriptions`

Stripe subscription data (synced via webhooks).

```sql
CREATE TABLE subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  license_key UUID NOT NULL REFERENCES licenses(license_key) ON DELETE CASCADE,

  -- Stripe IDs
  stripe_subscription_id VARCHAR(255) UNIQUE NOT NULL,
  stripe_customer_id VARCHAR(255) NOT NULL,
  stripe_price_id VARCHAR(255) NOT NULL,

  -- Subscription details
  plan VARCHAR(50) NOT NULL,
  status VARCHAR(50) NOT NULL, -- 'active', 'past_due', 'canceled', 'incomplete'

  -- Billing dates
  current_period_start TIMESTAMPTZ NOT NULL,
  current_period_end TIMESTAMPTZ NOT NULL,
  cancel_at_period_end BOOLEAN DEFAULT FALSE,
  canceled_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,

  -- Metadata
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT chk_sub_status CHECK (status IN ('active', 'past_due', 'canceled', 'incomplete', 'trialing'))
);

CREATE INDEX idx_subscriptions_license ON subscriptions(license_key);
CREATE INDEX idx_subscriptions_stripe ON subscriptions(stripe_subscription_id);
CREATE INDEX idx_subscriptions_status ON subscriptions(status);
```

**Notes:**
- Created/updated by Stripe webhook events
- `current_period_end` determines next billing date
- Used to sync license status with Stripe subscription status
- Backend runtime currently reads only `plan`, `status`, `current_period_end`,
  `cancel_at_period_end`, and `stripe_subscription_id`; the remaining columns
  are sync metadata and should be treated as deprecate-first if they are no
  longer needed externally.

---

### 6. `credits` (dropped)

Legacy one-time credit purchase table from the old quota system. Dropped by
`migrations/005_drop_credits_table.sql`.

**Notes:**
- No backend runtime reads/writes remain in this repository.
- Monthly quota now comes from `usage_logs` + `quota_summaries`.

---

### 7. `debug_logs`

Error and debug logs for troubleshooting.

```sql
CREATE TABLE debug_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Context
  license_key UUID REFERENCES licenses(license_key) ON DELETE SET NULL,
  site_hash VARCHAR(255),
  user_email VARCHAR(255),

  -- Log details
  level VARCHAR(50) NOT NULL, -- 'error', 'warn', 'info', 'debug'
  message TEXT NOT NULL,
  error_code VARCHAR(100),
  stack_trace TEXT,

  -- Request context
  request_id UUID,
  endpoint VARCHAR(255),
  http_method VARCHAR(10),
  http_status INTEGER,

  -- Metadata (JSON for flexible data)
  metadata JSONB,

  -- Timestamp
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT chk_log_level CHECK (level IN ('error', 'warn', 'info', 'debug'))
);

CREATE INDEX idx_debug_logs_license ON debug_logs(license_key);
CREATE INDEX idx_debug_logs_created_at ON debug_logs(created_at);
CREATE INDEX idx_debug_logs_level ON debug_logs(level);
CREATE INDEX idx_debug_logs_error_code ON debug_logs(error_code);
```

**Notes:**
- Visible in dashboard for license owner
- Helps diagnose plugin issues
- Auto-cleanup old logs (>90 days) with scheduled job

---

### 8. `dashboard_sessions`

Session tokens for dashboard web app login.

```sql
CREATE TABLE dashboard_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  license_key UUID NOT NULL REFERENCES licenses(license_key) ON DELETE CASCADE,

  -- Session details
  session_token VARCHAR(255) UNIQUE NOT NULL,
  user_agent TEXT,
  ip_address INET,

  -- Expiration
  expires_at TIMESTAMPTZ NOT NULL,

  -- Metadata
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_activity_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_dashboard_sessions_license ON dashboard_sessions(license_key);
CREATE INDEX idx_dashboard_sessions_token ON dashboard_sessions(session_token);
CREATE INDEX idx_dashboard_sessions_expires ON dashboard_sessions(expires_at);
```

**Notes:**
- Used for dashboard web app authentication (not plugin)
- Auto-cleanup expired sessions with scheduled job
- Session tokens are random UUIDs (not JWTs)

---

## Views

### `v_license_quota_current`

Legacy compatibility view for historical reference only. The backend runtime
does not query this view.

```sql
CREATE VIEW v_license_quota_current AS
SELECT
  l.license_key,
  l.plan,
  l.status AS license_status,
  l.billing_anchor_date,
  CASE l.plan
    WHEN 'free' THEN 50
    WHEN 'pro' THEN 1000
    WHEN 'agency' THEN 10000
  END AS total_limit,
  COALESCE(qs.total_credits_used, 0) AS credits_used,
  GREATEST(0, CASE l.plan
    WHEN 'free' THEN 50
    WHEN 'pro' THEN 1000
    WHEN 'agency' THEN 10000
  END - COALESCE(qs.total_credits_used, 0)) AS credits_remaining,
  qs.period_start,
  qs.period_end,
  qs.site_usage
FROM licenses l
LEFT JOIN quota_summaries qs ON l.license_key = qs.license_key
  AND qs.period_start <= NOW()
  AND qs.period_end > NOW();
```

---

## Triggers

### Update `quota_summaries` on `usage_logs` insert

```sql
CREATE OR REPLACE FUNCTION update_quota_summary()
RETURNS TRIGGER AS $$
BEGIN
  -- Upsert quota_summaries for current period
  INSERT INTO quota_summaries (
    license_key,
    period_start,
    period_end,
    total_credits_used,
    total_limit,
    site_usage
  )
  SELECT
    NEW.license_key,
    date_trunc('month', l.billing_anchor_date) AS period_start,
    date_trunc('month', l.billing_anchor_date) + INTERVAL '1 month' AS period_end,
    NEW.credits_used,
    CASE l.plan
      WHEN 'free' THEN 50
      WHEN 'pro' THEN 1000
      WHEN 'agency' THEN 10000
    END,
    jsonb_build_object(NEW.site_hash, NEW.credits_used)
  FROM licenses l
  WHERE l.license_key = NEW.license_key
  ON CONFLICT (license_key, period_start)
  DO UPDATE SET
    total_credits_used = quota_summaries.total_credits_used + NEW.credits_used,
    site_usage = jsonb_set(
      COALESCE(quota_summaries.site_usage, '{}'::jsonb),
      ARRAY[NEW.site_hash],
      (COALESCE((quota_summaries.site_usage->>NEW.site_hash)::integer, 0) + NEW.credits_used)::text::jsonb
    ),
    updated_at = NOW();

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_update_quota_summary
AFTER INSERT ON usage_logs
FOR EACH ROW
EXECUTE FUNCTION update_quota_summary();
```

---

### Update `licenses.updated_at` on changes

```sql
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_licenses_updated_at
BEFORE UPDATE ON licenses
FOR EACH ROW
EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trg_sites_updated_at
BEFORE UPDATE ON sites
FOR EACH ROW
EXECUTE FUNCTION update_updated_at();
```

---

## Scheduled Jobs

### Cleanup expired sessions

```sql
-- Run daily
DELETE FROM dashboard_sessions
WHERE expires_at < NOW() - INTERVAL '7 days';
```

### Cleanup old debug logs

```sql
-- Run weekly
DELETE FROM debug_logs
WHERE created_at < NOW() - INTERVAL '90 days';
```

### Update expired licenses

```sql
-- Run hourly
UPDATE licenses
SET status = 'expired'
WHERE expires_at IS NOT NULL
  AND expires_at < NOW()
  AND status = 'active';
```

---

## Sample Queries

### Get current quota for a license

```sql
SELECT
  credits_used,
  credits_remaining,
  total_limit,
  plan,
  period_end AS reset_date
FROM v_license_quota_current
WHERE license_key = 'xxx-xxx-xxx';
```

### Get per-user usage for a site

```sql
SELECT
  user_email,
  user_id,
  SUM(credits_used) AS credits_used,
  MAX(created_at) AS last_activity
FROM usage_logs
WHERE site_hash = 'abc123'
  AND created_at >= '2025-12-01'
  AND created_at < '2026-01-01'
GROUP BY user_email, user_id
ORDER BY credits_used DESC;
```

### Get agency site breakdown

```sql
SELECT
  s.site_name,
  s.site_url,
  s.quota_limit,
  (qs.site_usage->>s.site_hash)::integer AS credits_used,
  s.status
FROM sites s
JOIN quota_summaries qs ON qs.license_key = s.license_key
WHERE s.license_key = 'agency-license-key'
  AND qs.period_start <= NOW()
  AND qs.period_end > NOW();
```

---

## Migration from Legacy Schema

### Mapping Old Tables → New Tables

| Legacy Table | New Table | Notes |
|-------------|-----------|-------|
| `organizations` | `licenses` | Organization → License |
| `organization_members` | ❌ Removed | Users share license quota |
| `password_reset_tokens` | ❌ Removed | Password reset now lives on `licenses` |
| `users` | ❌ Removed | Dashboard uses email/password in licenses table |
| `sites` | `sites` | Same structure |
| `usage_logs` | `usage_logs` | Added user tracking fields |
| `subscriptions` | `subscriptions` | Same structure |
| `credits` | ❌ Dropped | Replaced by usage_logs + quota_summaries |

### Migration Script

See `migrations/001_legacy_to_v2.sql` for full migration script.

---

**End of Database Schema**
