-- Migration 20260421143000: linked-project replay of the production-safe
-- site-owned quota V2 restore.
--
-- This mirrors fresh-stack/migrations/011_restore_site_owned_quota_v2_safe.sql
-- so the linked Supabase project's migration history records the repair that
-- closes the live 008/009 deployment gap.
--
-- Purpose:
-- - replay the additive V2 schema from migration 008 when production never received it
-- - preserve the working legacy path while making the V2 path available
-- - keep duplicate site_hash handling diagnostic-only for now
--
-- Operational note:
-- - this script is intended for manual production execution without wrapping the
--   whole file in an explicit BEGIN/COMMIT, because several legacy-table indexes
--   are built CONCURRENTLY to reduce write blocking
-- - if your migrator always wraps DDL in one transaction, run the CONCURRENTLY
--   index statements as a follow-up step

CREATE EXTENSION IF NOT EXISTS pgcrypto;

SET lock_timeout = '5s';
SET statement_timeout = '0';

-- ---------------------------------------------------------------------------
-- 0. Re-apply essential legacy prerequisites from migrations 003 and 009
-- ---------------------------------------------------------------------------

ALTER TABLE IF EXISTS public.sites
  ALTER COLUMN license_key DROP NOT NULL;

ALTER TABLE IF EXISTS public.sites
  ALTER COLUMN site_url DROP NOT NULL;

ALTER TABLE IF EXISTS public.trial_usage
  ADD COLUMN IF NOT EXISTS anon_id VARCHAR(128),
  ADD COLUMN IF NOT EXISTS anonymous_risk_key VARCHAR(64),
  ADD COLUMN IF NOT EXISTS ip_hash VARCHAR(64);

-- ---------------------------------------------------------------------------
-- 1. Align legacy tables with runtime expectations
-- ---------------------------------------------------------------------------

ALTER TABLE IF EXISTS public.licenses
  ADD COLUMN IF NOT EXISTS billing_day_of_month INTEGER,
  ADD COLUMN IF NOT EXISTS password_reset_token VARCHAR(255),
  ADD COLUMN IF NOT EXISTS password_reset_expires TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_generation_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reengagement_sent BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE IF EXISTS public.usage_logs
  ADD COLUMN IF NOT EXISTS license_id UUID,
  ADD COLUMN IF NOT EXISTS plugin_version VARCHAR(64),
  ADD COLUMN IF NOT EXISTS endpoint VARCHAR(255) DEFAULT 'api/alt-text',
  ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT 'success',
  ADD COLUMN IF NOT EXISTS error_message TEXT;

CREATE TABLE IF NOT EXISTS public.subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  license_key VARCHAR(255) REFERENCES public.licenses(license_key) ON DELETE CASCADE,
  stripe_subscription_id VARCHAR(255) UNIQUE NOT NULL,
  stripe_customer_id VARCHAR(255),
  stripe_price_id VARCHAR(255),
  plan VARCHAR(50),
  status VARCHAR(50) NOT NULL DEFAULT 'active',
  current_period_start TIMESTAMPTZ,
  current_period_end TIMESTAMPTZ,
  cancel_at_period_end BOOLEAN DEFAULT FALSE,
  canceled_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE IF EXISTS public.subscriptions
  ADD COLUMN IF NOT EXISTS license_key VARCHAR(255),
  ADD COLUMN IF NOT EXISTS site_id UUID,
  ADD COLUMN IF NOT EXISTS stripe_customer_id VARCHAR(255),
  ADD COLUMN IF NOT EXISTS stripe_price_id VARCHAR(255),
  ADD COLUMN IF NOT EXISTS plan VARCHAR(50),
  ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS current_period_start TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS current_period_end TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cancel_at_period_end BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS canceled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS ended_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE table_schema = 'public'
      AND table_name = 'subscriptions'
      AND constraint_name = 'fk_subscriptions_license_key'
  ) THEN
    ALTER TABLE public.subscriptions
      ADD CONSTRAINT fk_subscriptions_license_key
      FOREIGN KEY (license_key) REFERENCES public.licenses(license_key) ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE table_schema = 'public'
      AND table_name = 'subscriptions'
      AND constraint_name = 'fk_subscriptions_site'
  ) THEN
    ALTER TABLE public.subscriptions
      ADD CONSTRAINT fk_subscriptions_site
      FOREIGN KEY (site_id) REFERENCES public.sites(id) ON DELETE SET NULL;
  END IF;
END;
$$;

UPDATE public.subscriptions sub
SET license_key = l.license_key
FROM public.licenses l
WHERE sub.license_key IS NULL
  AND (
    sub.user_id = l.id
    OR (l.user_id IS NOT NULL AND sub.user_id = l.user_id)
  );

-- ---------------------------------------------------------------------------
-- 2. Canonical site identity columns from migration 008
-- ---------------------------------------------------------------------------

ALTER TABLE IF EXISTS public.sites
  ADD COLUMN IF NOT EXISTS normalized_site_url VARCHAR(500),
  ADD COLUMN IF NOT EXISTS canonical_domain VARCHAR(255),
  ADD COLUMN IF NOT EXISTS site_fingerprint VARCHAR(255),
  ADD COLUMN IF NOT EXISTS wp_install_uuid VARCHAR(255),
  ADD COLUMN IF NOT EXISTS owner_user_id UUID,
  ADD COLUMN IF NOT EXISTS first_seen_at TIMESTAMPTZ DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS merged_into_site_id UUID,
  ADD COLUMN IF NOT EXISTS suspicious_attempt_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS environment VARCHAR(20) NOT NULL DEFAULT 'production';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE table_schema = 'public'
      AND table_name = 'sites'
      AND constraint_name = 'fk_sites_owner_user'
  ) THEN
    ALTER TABLE public.sites
      ADD CONSTRAINT fk_sites_owner_user
      FOREIGN KEY (owner_user_id) REFERENCES public.licenses(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE table_schema = 'public'
      AND table_name = 'sites'
      AND constraint_name = 'fk_sites_merged_into'
  ) THEN
    ALTER TABLE public.sites
      ADD CONSTRAINT fk_sites_merged_into
      FOREIGN KEY (merged_into_site_id) REFERENCES public.sites(id) ON DELETE SET NULL;
  END IF;
END;
$$;

UPDATE public.sites
SET
  site_fingerprint = COALESCE(site_fingerprint, fingerprint),
  wp_install_uuid = COALESCE(wp_install_uuid, site_hash),
  first_seen_at = COALESCE(first_seen_at, activated_at, last_activity_at, NOW()),
  last_seen_at = COALESCE(last_seen_at, last_activity_at, activated_at, NOW()),
  updated_at = COALESCE(updated_at, NOW()),
  environment = COALESCE(NULLIF(environment, ''), 'production')
WHERE site_fingerprint IS NULL
   OR wp_install_uuid IS NULL
   OR first_seen_at IS NULL
   OR last_seen_at IS NULL
   OR updated_at IS NULL
   OR environment IS NULL
   OR environment = '';

UPDATE public.sites s
SET owner_user_id = l.id
FROM public.licenses l
WHERE s.owner_user_id IS NULL
  AND s.license_key IS NOT NULL
  AND l.license_key = s.license_key;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.sites
    WHERE status IS NOT NULL
      AND status NOT IN ('active', 'deactivated', 'merged', 'suspended')
  ) THEN
    BEGIN
      ALTER TABLE public.sites DROP CONSTRAINT IF EXISTS chk_site_status;
      ALTER TABLE public.sites
        ADD CONSTRAINT chk_site_status
        CHECK (status IN ('active', 'deactivated', 'merged', 'suspended'));
    EXCEPTION
      WHEN duplicate_object THEN NULL;
    END;
  ELSE
    RAISE NOTICE 'Skipping chk_site_status recreation because unexpected site status values exist';
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- 3. Canonical plans and V2 ownership tables
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.plans (
  id VARCHAR(50) PRIMARY KEY,
  display_name VARCHAR(100) NOT NULL,
  scope VARCHAR(20) NOT NULL DEFAULT 'site',
  monthly_included_credits INTEGER NOT NULL DEFAULT 0,
  credit_grant_amount INTEGER NOT NULL DEFAULT 0,
  billing_interval_default VARCHAR(20),
  is_paid BOOLEAN NOT NULL DEFAULT FALSE,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_plans_scope CHECK (scope IN ('site', 'shared', 'credits')),
  CONSTRAINT chk_plans_interval CHECK (
    billing_interval_default IS NULL
    OR billing_interval_default IN ('month', 'year', 'one_time')
  )
);

INSERT INTO public.plans (id, display_name, scope, monthly_included_credits, credit_grant_amount, billing_interval_default, is_paid, metadata)
VALUES
  ('free', 'Free', 'site', 50, 0, 'month', FALSE, '{"source":"site_default"}'::jsonb),
  ('pro', 'Pro', 'site', 1000, 0, 'month', TRUE, '{"scope":"single_site"}'::jsonb),
  ('agency', 'Agency', 'shared', 10000, 0, 'month', TRUE, '{"scope":"multi_site"}'::jsonb),
  ('credits', 'Credit Pack', 'site', 0, 100, 'one_time', TRUE, '{"top_up":true}'::jsonb)
ON CONFLICT (id) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  scope = EXCLUDED.scope,
  monthly_included_credits = EXCLUDED.monthly_included_credits,
  credit_grant_amount = EXCLUDED.credit_grant_amount,
  billing_interval_default = EXCLUDED.billing_interval_default,
  is_paid = EXCLUDED.is_paid,
  metadata = EXCLUDED.metadata,
  updated_at = NOW();

ALTER TABLE IF EXISTS public.plans
  ADD COLUMN IF NOT EXISTS display_name VARCHAR(100),
  ADD COLUMN IF NOT EXISTS scope VARCHAR(20) DEFAULT 'site',
  ADD COLUMN IF NOT EXISTS monthly_included_credits INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS credit_grant_amount INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS billing_interval_default VARCHAR(20),
  ADD COLUMN IF NOT EXISTS is_paid BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE TABLE IF NOT EXISTS public.site_memberships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id UUID NOT NULL REFERENCES public.sites(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.licenses(id) ON DELETE CASCADE,
  role VARCHAR(20) NOT NULL DEFAULT 'member',
  invited_by_user_id UUID REFERENCES public.licenses(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_site_memberships_site_user UNIQUE (site_id, user_id),
  CONSTRAINT chk_site_memberships_role CHECK (role IN ('owner', 'admin', 'member'))
);

ALTER TABLE IF EXISTS public.site_memberships
  ADD COLUMN IF NOT EXISTS site_id UUID,
  ADD COLUMN IF NOT EXISTS user_id UUID,
  ADD COLUMN IF NOT EXISTS role VARCHAR(20) DEFAULT 'member',
  ADD COLUMN IF NOT EXISTS invited_by_user_id UUID,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE TABLE IF NOT EXISTS public.site_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id UUID NOT NULL REFERENCES public.sites(id) ON DELETE CASCADE,
  plan_id VARCHAR(50) REFERENCES public.plans(id) ON DELETE SET NULL,
  stripe_customer_id VARCHAR(255),
  stripe_subscription_id VARCHAR(255),
  status VARCHAR(50) NOT NULL DEFAULT 'active',
  billing_interval VARCHAR(20),
  current_period_start TIMESTAMPTZ,
  current_period_end TIMESTAMPTZ,
  cancel_at_period_end BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_site_subscriptions_stripe_subscription_id UNIQUE (stripe_subscription_id),
  CONSTRAINT chk_site_subscriptions_status CHECK (
    status IN ('active', 'trialing', 'past_due', 'canceled', 'incomplete', 'incomplete_expired')
  ),
  CONSTRAINT chk_site_subscriptions_interval CHECK (
    billing_interval IS NULL
    OR billing_interval IN ('month', 'year', 'one_time')
  )
);

ALTER TABLE IF EXISTS public.site_subscriptions
  ADD COLUMN IF NOT EXISTS site_id UUID,
  ADD COLUMN IF NOT EXISTS plan_id VARCHAR(50),
  ADD COLUMN IF NOT EXISTS stripe_customer_id VARCHAR(255),
  ADD COLUMN IF NOT EXISTS stripe_subscription_id VARCHAR(255),
  ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS billing_interval VARCHAR(20),
  ADD COLUMN IF NOT EXISTS current_period_start TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS current_period_end TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cancel_at_period_end BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE TABLE IF NOT EXISTS public.site_quotas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id UUID NOT NULL REFERENCES public.sites(id) ON DELETE CASCADE,
  quota_period_start TIMESTAMPTZ NOT NULL,
  quota_period_end TIMESTAMPTZ NOT NULL,
  monthly_included_credits INTEGER NOT NULL DEFAULT 0,
  purchased_credits_balance INTEGER NOT NULL DEFAULT 0,
  bonus_credits_balance INTEGER NOT NULL DEFAULT 0,
  used_credits INTEGER NOT NULL DEFAULT 0,
  remaining_credits INTEGER NOT NULL DEFAULT 0,
  reset_source VARCHAR(50),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_site_quota_period UNIQUE (site_id, quota_period_start, quota_period_end)
);

ALTER TABLE IF EXISTS public.site_quotas
  ADD COLUMN IF NOT EXISTS site_id UUID,
  ADD COLUMN IF NOT EXISTS quota_period_start TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS quota_period_end TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS monthly_included_credits INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS purchased_credits_balance INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS bonus_credits_balance INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS used_credits INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS remaining_credits INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS reset_source VARCHAR(50),
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE TABLE IF NOT EXISTS public.site_trials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id UUID NOT NULL REFERENCES public.sites(id) ON DELETE CASCADE,
  trial_type VARCHAR(50) NOT NULL DEFAULT 'initial',
  total_trial_credits INTEGER NOT NULL DEFAULT 5,
  used_trial_credits INTEGER NOT NULL DEFAULT 0,
  status VARCHAR(50) NOT NULL DEFAULT 'active',
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  exhausted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_site_trials_status CHECK (status IN ('active', 'exhausted', 'cancelled'))
);

ALTER TABLE IF EXISTS public.site_trials
  ADD COLUMN IF NOT EXISTS site_id UUID,
  ADD COLUMN IF NOT EXISTS trial_type VARCHAR(50) DEFAULT 'initial',
  ADD COLUMN IF NOT EXISTS total_trial_credits INTEGER NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS used_trial_credits INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS exhausted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

ALTER TABLE IF EXISTS public.site_trials
  ALTER COLUMN total_trial_credits SET DEFAULT 5;

CREATE TABLE IF NOT EXISTS public.generation_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id UUID NOT NULL REFERENCES public.sites(id) ON DELETE CASCADE,
  user_id UUID REFERENCES public.licenses(id) ON DELETE SET NULL,
  site_quota_id UUID REFERENCES public.site_quotas(id) ON DELETE SET NULL,
  site_trial_id UUID REFERENCES public.site_trials(id) ON DELETE SET NULL,
  image_count INTEGER NOT NULL DEFAULT 1,
  credits_reserved INTEGER NOT NULL DEFAULT 0,
  credits_consumed INTEGER NOT NULL DEFAULT 0,
  quota_source VARCHAR(20) NOT NULL DEFAULT 'site_quota',
  status VARCHAR(50) NOT NULL DEFAULT 'reserved',
  idempotency_key VARCHAR(255),
  request_fingerprint VARCHAR(255),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finalized_at TIMESTAMPTZ,
  CONSTRAINT chk_generation_requests_status CHECK (status IN ('reserved', 'succeeded', 'released', 'failed')),
  CONSTRAINT chk_generation_requests_source CHECK (quota_source IN ('trial', 'site_quota'))
);

ALTER TABLE IF EXISTS public.generation_requests
  ADD COLUMN IF NOT EXISTS site_id UUID,
  ADD COLUMN IF NOT EXISTS user_id UUID,
  ADD COLUMN IF NOT EXISTS site_quota_id UUID,
  ADD COLUMN IF NOT EXISTS site_trial_id UUID,
  ADD COLUMN IF NOT EXISTS image_count INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS credits_reserved INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS credits_consumed INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS quota_source VARCHAR(20) DEFAULT 'site_quota',
  ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT 'reserved',
  ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(255),
  ADD COLUMN IF NOT EXISTS request_fingerprint VARCHAR(255),
  ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS finalized_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS public.usage_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id UUID NOT NULL REFERENCES public.sites(id) ON DELETE CASCADE,
  user_id UUID REFERENCES public.licenses(id) ON DELETE SET NULL,
  generation_id UUID REFERENCES public.generation_requests(id) ON DELETE SET NULL,
  event_type VARCHAR(50) NOT NULL,
  credits_delta INTEGER NOT NULL,
  idempotency_key VARCHAR(255),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_usage_events_type CHECK (
    event_type IN (
      'trial_reserve',
      'trial_consume',
      'trial_release',
      'quota_reserve',
      'quota_consume',
      'quota_release',
      'credit_purchase',
      'subscription_sync',
      'admin_adjustment',
      'refund',
      'site_merge'
    )
  )
);

ALTER TABLE IF EXISTS public.usage_events
  ADD COLUMN IF NOT EXISTS site_id UUID,
  ADD COLUMN IF NOT EXISTS user_id UUID,
  ADD COLUMN IF NOT EXISTS generation_id UUID,
  ADD COLUMN IF NOT EXISTS event_type VARCHAR(50),
  ADD COLUMN IF NOT EXISTS credits_delta INTEGER,
  ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(255),
  ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE TABLE IF NOT EXISTS public.site_audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id UUID REFERENCES public.sites(id) ON DELETE CASCADE,
  actor_user_id UUID REFERENCES public.licenses(id) ON DELETE SET NULL,
  event_type VARCHAR(100) NOT NULL,
  severity VARCHAR(20) NOT NULL DEFAULT 'info',
  request_id UUID,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_site_audit_logs_severity CHECK (severity IN ('info', 'warn', 'error'))
);

ALTER TABLE IF EXISTS public.site_audit_logs
  ADD COLUMN IF NOT EXISTS site_id UUID,
  ADD COLUMN IF NOT EXISTS actor_user_id UUID,
  ADD COLUMN IF NOT EXISTS event_type VARCHAR(100),
  ADD COLUMN IF NOT EXISTS severity VARCHAR(20) DEFAULT 'info',
  ADD COLUMN IF NOT EXISTS request_id UUID,
  ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE TABLE IF NOT EXISTS public.site_merges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_site_id UUID NOT NULL REFERENCES public.sites(id) ON DELETE CASCADE,
  target_site_id UUID NOT NULL REFERENCES public.sites(id) ON DELETE CASCADE,
  merged_by_user_id UUID REFERENCES public.licenses(id) ON DELETE SET NULL,
  reason TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_site_merges_distinct CHECK (source_site_id <> target_site_id)
);

ALTER TABLE IF EXISTS public.site_merges
  ADD COLUMN IF NOT EXISTS source_site_id UUID,
  ADD COLUMN IF NOT EXISTS target_site_id UUID,
  ADD COLUMN IF NOT EXISTS merged_by_user_id UUID,
  ADD COLUMN IF NOT EXISTS reason TEXT,
  ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- Deterministic bootstrap: explicit legacy site -> owner mappings.
INSERT INTO public.site_memberships (site_id, user_id, role)
SELECT s.id, l.id, 'owner'
FROM public.sites s
JOIN public.licenses l
  ON l.license_key = s.license_key
WHERE s.license_key IS NOT NULL
ON CONFLICT (site_id, user_id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 4. Indexes
-- ---------------------------------------------------------------------------

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_trial_usage_anon_id
  ON public.trial_usage(anon_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_trial_usage_risk_key
  ON public.trial_usage(anonymous_risk_key);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_usage_logs_license_id
  ON public.usage_logs(license_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_usage_logs_endpoint
  ON public.usage_logs(endpoint);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_usage_logs_status
  ON public.usage_logs(status);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_subscriptions_license_key
  ON public.subscriptions(license_key);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_subscriptions_status
  ON public.subscriptions(status);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_subscriptions_site_id
  ON public.subscriptions(site_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sites_owner_user_id
  ON public.sites(owner_user_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sites_wp_install_uuid
  ON public.sites(wp_install_uuid);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sites_site_fingerprint
  ON public.sites(site_fingerprint);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sites_canonical_domain
  ON public.sites(canonical_domain);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sites_normalized_site_url
  ON public.sites(normalized_site_url);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sites_merged_into_site_id
  ON public.sites(merged_into_site_id);

CREATE INDEX IF NOT EXISTS idx_site_memberships_user_id
  ON public.site_memberships(user_id);

CREATE INDEX IF NOT EXISTS idx_site_memberships_site_id
  ON public.site_memberships(site_id);

CREATE INDEX IF NOT EXISTS idx_site_subscriptions_site_id
  ON public.site_subscriptions(site_id);

CREATE INDEX IF NOT EXISTS idx_site_subscriptions_status
  ON public.site_subscriptions(status);

CREATE INDEX IF NOT EXISTS idx_site_subscriptions_customer_id
  ON public.site_subscriptions(stripe_customer_id);

CREATE INDEX IF NOT EXISTS idx_site_quotas_site_period
  ON public.site_quotas(site_id, quota_period_start DESC);

CREATE INDEX IF NOT EXISTS idx_site_trials_site_id
  ON public.site_trials(site_id);

CREATE INDEX IF NOT EXISTS idx_generation_requests_site_fingerprint
  ON public.generation_requests(site_id, request_fingerprint, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_usage_events_site_id_created_at
  ON public.usage_events(site_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_site_audit_logs_site_id
  ON public.site_audit_logs(site_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_site_merges_target_site_id
  ON public.site_merges(target_site_id, created_at DESC);

DO $$
BEGIN
  IF to_regclass('public.uq_site_memberships_site_user') IS NULL THEN
    IF EXISTS (
      SELECT 1
      FROM public.site_memberships
      GROUP BY site_id, user_id
      HAVING count(*) > 1
    ) THEN
      RAISE NOTICE 'Skipping uq_site_memberships_site_user because duplicates already exist';
    ELSE
      CREATE UNIQUE INDEX uq_site_memberships_site_user
        ON public.site_memberships(site_id, user_id);
    END IF;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_index idx
    JOIN pg_class rel ON rel.oid = idx.indrelid
    JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
    WHERE nsp.nspname = 'public'
      AND rel.relname = 'site_subscriptions'
      AND idx.indisunique
      AND pg_get_indexdef(idx.indexrelid) ILIKE '%(stripe_subscription_id)%'
  ) THEN
    IF EXISTS (
      SELECT 1
      FROM public.site_subscriptions
      WHERE stripe_subscription_id IS NOT NULL
      GROUP BY stripe_subscription_id
      HAVING count(*) > 1
    ) THEN
      RAISE NOTICE 'Skipping uq_site_subscriptions_stripe_subscription_id because duplicates already exist';
    ELSE
      CREATE UNIQUE INDEX uq_site_subscriptions_stripe_subscription_id
        ON public.site_subscriptions(stripe_subscription_id)
        WHERE stripe_subscription_id IS NOT NULL;
    END IF;
  END IF;

  IF to_regclass('public.uq_site_quota_period') IS NULL THEN
    IF EXISTS (
      SELECT 1
      FROM public.site_quotas
      GROUP BY site_id, quota_period_start, quota_period_end
      HAVING count(*) > 1
    ) THEN
      RAISE NOTICE 'Skipping uq_site_quota_period because duplicates already exist';
    ELSE
      CREATE UNIQUE INDEX uq_site_quota_period
        ON public.site_quotas(site_id, quota_period_start, quota_period_end);
    END IF;
  END IF;

  IF to_regclass('public.uq_site_trials_active_initial') IS NULL THEN
    IF EXISTS (
      SELECT 1
      FROM public.site_trials
      WHERE status = 'active'
        AND trial_type = 'initial'
      GROUP BY site_id
      HAVING count(*) > 1
    ) THEN
      RAISE NOTICE 'Skipping uq_site_trials_active_initial because multiple active initial trials already exist';
    ELSE
      CREATE UNIQUE INDEX uq_site_trials_active_initial
        ON public.site_trials(site_id)
        WHERE status = 'active' AND trial_type = 'initial';
    END IF;
  END IF;

  IF to_regclass('public.uq_generation_requests_idempotency_key') IS NULL THEN
    IF EXISTS (
      SELECT 1
      FROM public.generation_requests
      WHERE idempotency_key IS NOT NULL
      GROUP BY idempotency_key
      HAVING count(*) > 1
    ) THEN
      RAISE NOTICE 'Skipping uq_generation_requests_idempotency_key because duplicate idempotency keys already exist';
    ELSE
      CREATE UNIQUE INDEX uq_generation_requests_idempotency_key
        ON public.generation_requests(idempotency_key)
        WHERE idempotency_key IS NOT NULL;
    END IF;
  END IF;

  IF to_regclass('public.uq_usage_events_idempotency_key') IS NULL THEN
    IF EXISTS (
      SELECT 1
      FROM public.usage_events
      WHERE idempotency_key IS NOT NULL
      GROUP BY idempotency_key
      HAVING count(*) > 1
    ) THEN
      RAISE NOTICE 'Skipping uq_usage_events_idempotency_key because duplicate idempotency keys already exist';
    ELSE
      CREATE UNIQUE INDEX uq_usage_events_idempotency_key
        ON public.usage_events(idempotency_key)
        WHERE idempotency_key IS NOT NULL;
    END IF;
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- 5. RPC functions from migration 008, preserved as additive repair objects
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.bbai_reserve_site_generation(
  p_site_id UUID,
  p_user_id UUID DEFAULT NULL,
  p_credits INTEGER DEFAULT 1,
  p_idempotency_key TEXT DEFAULT NULL,
  p_request_fingerprint TEXT DEFAULT NULL,
  p_request_metadata JSONB DEFAULT '{}'::jsonb,
  p_quota_mode TEXT DEFAULT 'site',
  p_trial_credits INTEGER DEFAULT 5
) RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  v_existing public.generation_requests%ROWTYPE;
  v_generation public.generation_requests%ROWTYPE;
  v_subscription public.site_subscriptions%ROWTYPE;
  v_site_quota public.site_quotas%ROWTYPE;
  v_site_trial public.site_trials%ROWTYPE;
  v_plan public.plans%ROWTYPE;
  v_quota_mode TEXT := COALESCE(NULLIF(p_quota_mode, ''), 'site');
  v_metadata JSONB := COALESCE(p_request_metadata, '{}'::jsonb);
  v_quota_start TIMESTAMPTZ;
  v_quota_end TIMESTAMPTZ;
  v_included_credits INTEGER := 0;
  v_available INTEGER := 0;
  v_total_limit INTEGER := 0;
BEGIN
  IF p_site_id IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'code', 'SITE_REQUIRED');
  END IF;

  IF p_credits IS NULL OR p_credits < 1 THEN
    p_credits := 1;
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    SELECT *
    INTO v_existing
    FROM public.generation_requests
    WHERE idempotency_key = p_idempotency_key
    LIMIT 1;

    IF FOUND THEN
      RETURN jsonb_build_object(
        'ok', TRUE,
        'duplicate', TRUE,
        'status', v_existing.status,
        'generation_request_id', v_existing.id,
        'quota_source', v_existing.quota_source,
        'credits_reserved', v_existing.credits_reserved,
        'credits_consumed', v_existing.credits_consumed,
        'site_id', v_existing.site_id
      );
    END IF;
  END IF;

  IF p_request_fingerprint IS NOT NULL THEN
    SELECT *
    INTO v_existing
    FROM public.generation_requests
    WHERE site_id = p_site_id
      AND request_fingerprint = p_request_fingerprint
      AND status IN ('reserved', 'succeeded')
      AND created_at >= NOW() - INTERVAL '2 minutes'
    ORDER BY created_at DESC
    LIMIT 1;

    IF FOUND THEN
      RETURN jsonb_build_object(
        'ok', TRUE,
        'duplicate', TRUE,
        'status', v_existing.status,
        'generation_request_id', v_existing.id,
        'quota_source', v_existing.quota_source,
        'credits_reserved', v_existing.credits_reserved,
        'credits_consumed', v_existing.credits_consumed,
        'site_id', v_existing.site_id
      );
    END IF;
  END IF;

  IF v_quota_mode = 'trial' THEN
    SELECT *
    INTO v_site_trial
    FROM public.site_trials
    WHERE site_id = p_site_id
      AND trial_type = 'initial'
    ORDER BY CASE WHEN status = 'active' THEN 0 ELSE 1 END, created_at DESC
    LIMIT 1
    FOR UPDATE;

    IF NOT FOUND THEN
      INSERT INTO public.site_trials (
        site_id,
        trial_type,
        total_trial_credits,
        used_trial_credits,
        status
      ) VALUES (
        p_site_id,
        'initial',
        GREATEST(COALESCE(p_trial_credits, 5), 1),
        0,
        'active'
      )
      RETURNING * INTO v_site_trial;
    ELSIF v_site_trial.status <> 'active' THEN
      RETURN jsonb_build_object(
        'ok', FALSE,
        'code', 'TRIAL_EXHAUSTED',
        'remaining_credits', GREATEST(v_site_trial.total_trial_credits - v_site_trial.used_trial_credits, 0),
        'total_limit', v_site_trial.total_trial_credits
      );
    END IF;

    IF (v_site_trial.used_trial_credits + p_credits) > v_site_trial.total_trial_credits THEN
      UPDATE public.site_trials
      SET
        status = 'exhausted',
        exhausted_at = COALESCE(exhausted_at, NOW()),
        updated_at = NOW()
      WHERE id = v_site_trial.id;

      RETURN jsonb_build_object(
        'ok', FALSE,
        'code', 'TRIAL_EXHAUSTED',
        'remaining_credits', GREATEST(v_site_trial.total_trial_credits - v_site_trial.used_trial_credits, 0),
        'total_limit', v_site_trial.total_trial_credits
      );
    END IF;

    UPDATE public.site_trials
    SET
      used_trial_credits = used_trial_credits + p_credits,
      status = CASE WHEN (used_trial_credits + p_credits) >= total_trial_credits THEN 'exhausted' ELSE status END,
      exhausted_at = CASE WHEN (used_trial_credits + p_credits) >= total_trial_credits THEN COALESCE(exhausted_at, NOW()) ELSE exhausted_at END,
      updated_at = NOW()
    WHERE id = v_site_trial.id
    RETURNING * INTO v_site_trial;

    INSERT INTO public.generation_requests (
      site_id,
      user_id,
      site_trial_id,
      image_count,
      credits_reserved,
      credits_consumed,
      quota_source,
      status,
      idempotency_key,
      request_fingerprint,
      metadata
    ) VALUES (
      p_site_id,
      p_user_id,
      v_site_trial.id,
      1,
      p_credits,
      0,
      'trial',
      'reserved',
      p_idempotency_key,
      p_request_fingerprint,
      v_metadata
    )
    RETURNING * INTO v_generation;

    INSERT INTO public.usage_events (
      site_id,
      user_id,
      generation_id,
      event_type,
      credits_delta,
      idempotency_key,
      metadata
    ) VALUES (
      p_site_id,
      p_user_id,
      v_generation.id,
      'trial_reserve',
      -p_credits,
      CONCAT('reserve:', v_generation.id::text),
      v_metadata || jsonb_build_object('quota_mode', 'trial')
    );

    RETURN jsonb_build_object(
      'ok', TRUE,
      'status', 'reserved',
      'duplicate', FALSE,
      'quota_source', 'trial',
      'generation_request_id', v_generation.id,
      'remaining_credits', GREATEST(v_site_trial.total_trial_credits - v_site_trial.used_trial_credits, 0),
      'total_limit', v_site_trial.total_trial_credits,
      'credits_used', v_site_trial.used_trial_credits,
      'plan', 'trial'
    );
  END IF;

  SELECT *
  INTO v_subscription
  FROM public.site_subscriptions
  WHERE site_id = p_site_id
    AND status IN ('active', 'trialing', 'past_due')
  ORDER BY COALESCE(current_period_end, NOW()) DESC NULLS LAST
  LIMIT 1;

  IF FOUND THEN
    v_quota_start := COALESCE(v_subscription.current_period_start, date_trunc('month', NOW()));
    v_quota_end := COALESCE(v_subscription.current_period_end, v_quota_start + INTERVAL '1 month');
    SELECT * INTO v_plan FROM public.plans WHERE id = COALESCE(v_subscription.plan_id, 'free');
  ELSE
    v_quota_start := date_trunc('month', NOW());
    v_quota_end := v_quota_start + INTERVAL '1 month';
    SELECT * INTO v_plan FROM public.plans WHERE id = 'free';
  END IF;

  v_included_credits := COALESCE(
    v_plan.monthly_included_credits,
    CASE COALESCE(v_plan.id, 'free')
      WHEN 'pro' THEN 1000
      WHEN 'agency' THEN 10000
      ELSE 50
    END
  );

  INSERT INTO public.site_quotas (
    site_id,
    quota_period_start,
    quota_period_end,
    monthly_included_credits,
    purchased_credits_balance,
    bonus_credits_balance,
    used_credits,
    remaining_credits,
    reset_source
  ) VALUES (
    p_site_id,
    v_quota_start,
    v_quota_end,
    v_included_credits,
    0,
    0,
    0,
    v_included_credits,
    CASE WHEN v_subscription.id IS NULL THEN 'free_monthly' ELSE 'site_subscription' END
  )
  ON CONFLICT (site_id, quota_period_start, quota_period_end) DO UPDATE
  SET
    monthly_included_credits = GREATEST(public.site_quotas.monthly_included_credits, EXCLUDED.monthly_included_credits),
    updated_at = NOW(),
    remaining_credits = GREATEST(
      (GREATEST(public.site_quotas.monthly_included_credits, EXCLUDED.monthly_included_credits)
        + public.site_quotas.purchased_credits_balance
        + public.site_quotas.bonus_credits_balance)
      - public.site_quotas.used_credits,
      0
    )
  RETURNING * INTO v_site_quota;

  SELECT *
  INTO v_site_quota
  FROM public.site_quotas
  WHERE id = v_site_quota.id
  FOR UPDATE;

  v_total_limit := v_site_quota.monthly_included_credits
    + v_site_quota.purchased_credits_balance
    + v_site_quota.bonus_credits_balance;
  v_available := GREATEST(v_total_limit - v_site_quota.used_credits, 0);

  IF v_available < p_credits THEN
    RETURN jsonb_build_object(
      'ok', FALSE,
      'code', 'QUOTA_EXCEEDED',
      'remaining_credits', v_available,
      'total_limit', v_total_limit,
      'credits_used', v_site_quota.used_credits,
      'plan', COALESCE(v_plan.id, 'free'),
      'quota_period_end', v_site_quota.quota_period_end
    );
  END IF;

  UPDATE public.site_quotas
  SET
    used_credits = used_credits + p_credits,
    remaining_credits = GREATEST(
      (monthly_included_credits + purchased_credits_balance + bonus_credits_balance)
      - (used_credits + p_credits),
      0
    ),
    updated_at = NOW()
  WHERE id = v_site_quota.id
  RETURNING * INTO v_site_quota;

  INSERT INTO public.generation_requests (
    site_id,
    user_id,
    site_quota_id,
    image_count,
    credits_reserved,
    credits_consumed,
    quota_source,
    status,
    idempotency_key,
    request_fingerprint,
    metadata
  ) VALUES (
    p_site_id,
    p_user_id,
    v_site_quota.id,
    1,
    p_credits,
    0,
    'site_quota',
    'reserved',
    p_idempotency_key,
    p_request_fingerprint,
    v_metadata
  )
  RETURNING * INTO v_generation;

  INSERT INTO public.usage_events (
    site_id,
    user_id,
    generation_id,
    event_type,
    credits_delta,
    idempotency_key,
    metadata
  ) VALUES (
    p_site_id,
    p_user_id,
    v_generation.id,
    'quota_reserve',
    -p_credits,
    CONCAT('reserve:', v_generation.id::text),
    v_metadata || jsonb_build_object(
      'quota_mode', 'site',
      'plan', COALESCE(v_plan.id, 'free'),
      'quota_period_start', v_site_quota.quota_period_start,
      'quota_period_end', v_site_quota.quota_period_end
    )
  );

  RETURN jsonb_build_object(
    'ok', TRUE,
    'status', 'reserved',
    'duplicate', FALSE,
    'quota_source', 'site_quota',
    'generation_request_id', v_generation.id,
    'remaining_credits', v_site_quota.remaining_credits,
    'total_limit', v_total_limit,
    'credits_used', v_site_quota.used_credits,
    'plan', COALESCE(v_plan.id, 'free'),
    'quota_period_end', v_site_quota.quota_period_end
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.bbai_finalize_site_generation(
  p_generation_request_id UUID,
  p_success BOOLEAN,
  p_final_metadata JSONB DEFAULT '{}'::jsonb
) RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  v_generation public.generation_requests%ROWTYPE;
  v_site_quota public.site_quotas%ROWTYPE;
  v_site_trial public.site_trials%ROWTYPE;
  v_metadata JSONB := COALESCE(p_final_metadata, '{}'::jsonb);
BEGIN
  SELECT *
  INTO v_generation
  FROM public.generation_requests
  WHERE id = p_generation_request_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', FALSE, 'code', 'GENERATION_NOT_FOUND');
  END IF;

  IF v_generation.status IN ('succeeded', 'released', 'failed') THEN
    RETURN jsonb_build_object(
      'ok', TRUE,
      'status', v_generation.status,
      'generation_request_id', v_generation.id,
      'credits_reserved', v_generation.credits_reserved,
      'credits_consumed', v_generation.credits_consumed
    );
  END IF;

  IF p_success THEN
    UPDATE public.generation_requests
    SET
      status = 'succeeded',
      credits_consumed = credits_reserved,
      finalized_at = NOW(),
      updated_at = NOW(),
      metadata = COALESCE(metadata, '{}'::jsonb) || v_metadata
    WHERE id = v_generation.id
    RETURNING * INTO v_generation;

    INSERT INTO public.usage_events (
      site_id,
      user_id,
      generation_id,
      event_type,
      credits_delta,
      idempotency_key,
      metadata
    ) VALUES (
      v_generation.site_id,
      v_generation.user_id,
      v_generation.id,
      CASE WHEN v_generation.quota_source = 'trial' THEN 'trial_consume' ELSE 'quota_consume' END,
      0,
      CONCAT('consume:', v_generation.id::text),
      v_metadata
    )
    ON CONFLICT DO NOTHING;

    RETURN jsonb_build_object(
      'ok', TRUE,
      'status', 'succeeded',
      'generation_request_id', v_generation.id,
      'credits_reserved', v_generation.credits_reserved,
      'credits_consumed', v_generation.credits_consumed
    );
  END IF;

  IF v_generation.quota_source = 'trial' AND v_generation.site_trial_id IS NOT NULL THEN
    UPDATE public.site_trials
    SET
      used_trial_credits = GREATEST(used_trial_credits - v_generation.credits_reserved, 0),
      status = CASE
        WHEN GREATEST(used_trial_credits - v_generation.credits_reserved, 0) < total_trial_credits THEN 'active'
        ELSE status
      END,
      exhausted_at = CASE
        WHEN GREATEST(used_trial_credits - v_generation.credits_reserved, 0) < total_trial_credits THEN NULL
        ELSE exhausted_at
      END,
      updated_at = NOW()
    WHERE id = v_generation.site_trial_id
    RETURNING * INTO v_site_trial;
  ELSIF v_generation.site_quota_id IS NOT NULL THEN
    UPDATE public.site_quotas
    SET
      used_credits = GREATEST(used_credits - v_generation.credits_reserved, 0),
      remaining_credits = GREATEST(
        (monthly_included_credits + purchased_credits_balance + bonus_credits_balance)
        - GREATEST(used_credits - v_generation.credits_reserved, 0),
        0
      ),
      updated_at = NOW()
    WHERE id = v_generation.site_quota_id
    RETURNING * INTO v_site_quota;
  END IF;

  UPDATE public.generation_requests
  SET
    status = 'released',
    finalized_at = NOW(),
    updated_at = NOW(),
    metadata = COALESCE(metadata, '{}'::jsonb) || v_metadata
  WHERE id = v_generation.id
  RETURNING * INTO v_generation;

  INSERT INTO public.usage_events (
    site_id,
    user_id,
    generation_id,
    event_type,
    credits_delta,
    idempotency_key,
    metadata
  ) VALUES (
    v_generation.site_id,
    v_generation.user_id,
    v_generation.id,
    CASE WHEN v_generation.quota_source = 'trial' THEN 'trial_release' ELSE 'quota_release' END,
    v_generation.credits_reserved,
    CONCAT('release:', v_generation.id::text),
    v_metadata
  )
  ON CONFLICT DO NOTHING;

  RETURN jsonb_build_object(
    'ok', TRUE,
    'status', 'released',
    'generation_request_id', v_generation.id,
    'credits_reserved', v_generation.credits_reserved,
    'credits_consumed', 0
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.bbai_apply_site_billing_event(
  p_site_id UUID,
  p_stripe_event_id TEXT,
  p_plan_id TEXT,
  p_purchase_type TEXT,
  p_billing_interval TEXT DEFAULT NULL,
  p_stripe_customer_id TEXT DEFAULT NULL,
  p_stripe_subscription_id TEXT DEFAULT NULL,
  p_subscription_status TEXT DEFAULT 'active',
  p_current_period_start TIMESTAMPTZ DEFAULT NULL,
  p_current_period_end TIMESTAMPTZ DEFAULT NULL,
  p_metadata JSONB DEFAULT '{}'::jsonb
) RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  v_existing public.usage_events%ROWTYPE;
  v_plan public.plans%ROWTYPE;
  v_site_quota public.site_quotas%ROWTYPE;
  v_subscription public.site_subscriptions%ROWTYPE;
  v_quota_start TIMESTAMPTZ;
  v_quota_end TIMESTAMPTZ;
  v_credit_delta INTEGER := 0;
  v_idempotency_key TEXT := CONCAT('billing:', p_stripe_event_id);
BEGIN
  IF p_site_id IS NULL OR p_stripe_event_id IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'code', 'INVALID_BILLING_EVENT');
  END IF;

  SELECT *
  INTO v_existing
  FROM public.usage_events
  WHERE idempotency_key = v_idempotency_key
  LIMIT 1;

  IF FOUND THEN
    RETURN jsonb_build_object('ok', TRUE, 'duplicate', TRUE, 'event_id', p_stripe_event_id);
  END IF;

  SELECT *
  INTO v_plan
  FROM public.plans
  WHERE id = COALESCE(NULLIF(p_plan_id, ''), 'free');

  IF NOT FOUND THEN
    SELECT * INTO v_plan FROM public.plans WHERE id = 'free';
  END IF;

  IF COALESCE(p_purchase_type, 'unknown') IN ('new_purchase', 'upgrade', 'renewal') AND COALESCE(v_plan.id, 'free') <> 'credits' THEN
    INSERT INTO public.site_subscriptions (
      site_id,
      plan_id,
      stripe_customer_id,
      stripe_subscription_id,
      status,
      billing_interval,
      current_period_start,
      current_period_end,
      cancel_at_period_end,
      updated_at
    ) VALUES (
      p_site_id,
      v_plan.id,
      p_stripe_customer_id,
      p_stripe_subscription_id,
      COALESCE(p_subscription_status, 'active'),
      COALESCE(p_billing_interval, v_plan.billing_interval_default),
      COALESCE(p_current_period_start, date_trunc('month', NOW())),
      COALESCE(p_current_period_end, date_trunc('month', NOW()) + INTERVAL '1 month'),
      FALSE,
      NOW()
    )
    ON CONFLICT (stripe_subscription_id) DO UPDATE
    SET
      site_id = EXCLUDED.site_id,
      plan_id = EXCLUDED.plan_id,
      stripe_customer_id = EXCLUDED.stripe_customer_id,
      status = EXCLUDED.status,
      billing_interval = EXCLUDED.billing_interval,
      current_period_start = EXCLUDED.current_period_start,
      current_period_end = EXCLUDED.current_period_end,
      updated_at = NOW()
    RETURNING * INTO v_subscription;

    v_quota_start := COALESCE(v_subscription.current_period_start, date_trunc('month', NOW()));
    v_quota_end := COALESCE(v_subscription.current_period_end, v_quota_start + INTERVAL '1 month');

    INSERT INTO public.site_quotas (
      site_id,
      quota_period_start,
      quota_period_end,
      monthly_included_credits,
      purchased_credits_balance,
      bonus_credits_balance,
      used_credits,
      remaining_credits,
      reset_source
    ) VALUES (
      p_site_id,
      v_quota_start,
      v_quota_end,
      COALESCE(v_plan.monthly_included_credits, 0),
      0,
      0,
      0,
      COALESCE(v_plan.monthly_included_credits, 0),
      'stripe_webhook'
    )
    ON CONFLICT (site_id, quota_period_start, quota_period_end) DO UPDATE
    SET
      monthly_included_credits = GREATEST(public.site_quotas.monthly_included_credits, EXCLUDED.monthly_included_credits),
      remaining_credits = GREATEST(
        (GREATEST(public.site_quotas.monthly_included_credits, EXCLUDED.monthly_included_credits)
          + public.site_quotas.purchased_credits_balance
          + public.site_quotas.bonus_credits_balance)
        - public.site_quotas.used_credits,
        0
      ),
      updated_at = NOW()
    RETURNING * INTO v_site_quota;
  ELSIF COALESCE(p_purchase_type, 'unknown') = 'credit_top_up' OR COALESCE(v_plan.id, 'free') = 'credits' THEN
    SELECT *
    INTO v_subscription
    FROM public.site_subscriptions
    WHERE site_id = p_site_id
      AND status IN ('active', 'trialing', 'past_due')
    ORDER BY COALESCE(current_period_end, NOW()) DESC NULLS LAST
    LIMIT 1;

    IF FOUND THEN
      v_quota_start := COALESCE(v_subscription.current_period_start, date_trunc('month', NOW()));
      v_quota_end := COALESCE(v_subscription.current_period_end, v_quota_start + INTERVAL '1 month');
    ELSE
      v_quota_start := date_trunc('month', NOW());
      v_quota_end := v_quota_start + INTERVAL '1 month';
    END IF;

    INSERT INTO public.site_quotas (
      site_id,
      quota_period_start,
      quota_period_end,
      monthly_included_credits,
      purchased_credits_balance,
      bonus_credits_balance,
      used_credits,
      remaining_credits,
      reset_source
    ) VALUES (
      p_site_id,
      v_quota_start,
      v_quota_end,
      0,
      0,
      0,
      0,
      0,
      'stripe_webhook'
    )
    ON CONFLICT (site_id, quota_period_start, quota_period_end) DO UPDATE
    SET updated_at = NOW()
    RETURNING * INTO v_site_quota;

    v_credit_delta := COALESCE(v_plan.credit_grant_amount, 0);

    UPDATE public.site_quotas
    SET
      purchased_credits_balance = purchased_credits_balance + v_credit_delta,
      remaining_credits = GREATEST(
        (monthly_included_credits + purchased_credits_balance + v_credit_delta + bonus_credits_balance)
        - used_credits,
        0
      ),
      updated_at = NOW()
    WHERE id = v_site_quota.id
    RETURNING * INTO v_site_quota;
  END IF;

  INSERT INTO public.usage_events (
    site_id,
    event_type,
    credits_delta,
    idempotency_key,
    metadata
  ) VALUES (
    p_site_id,
    CASE
      WHEN COALESCE(p_purchase_type, 'unknown') = 'credit_top_up' OR COALESCE(v_plan.id, 'free') = 'credits' THEN 'credit_purchase'
      ELSE 'subscription_sync'
    END,
    v_credit_delta,
    v_idempotency_key,
    COALESCE(p_metadata, '{}'::jsonb)
      || jsonb_build_object(
        'plan_id', v_plan.id,
        'purchase_type', COALESCE(p_purchase_type, 'unknown'),
        'billing_interval', COALESCE(p_billing_interval, v_plan.billing_interval_default)
      )
  );

  RETURN jsonb_build_object(
    'ok', TRUE,
    'duplicate', FALSE,
    'event_id', p_stripe_event_id,
    'plan_id', v_plan.id,
    'credit_delta', v_credit_delta,
    'site_quota_id', COALESCE(v_site_quota.id, NULL),
    'site_subscription_id', COALESCE(v_subscription.id, NULL)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.bbai_merge_sites(
  p_source_site_id UUID,
  p_target_site_id UUID,
  p_actor_user_id UUID DEFAULT NULL,
  p_reason TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  v_source public.sites%ROWTYPE;
  v_target public.sites%ROWTYPE;
  v_quota public.site_quotas%ROWTYPE;
  v_trial public.site_trials%ROWTYPE;
BEGIN
  IF p_source_site_id IS NULL OR p_target_site_id IS NULL OR p_source_site_id = p_target_site_id THEN
    RETURN jsonb_build_object('ok', FALSE, 'code', 'INVALID_SITE_MERGE');
  END IF;

  SELECT * INTO v_source FROM public.sites WHERE id = p_source_site_id FOR UPDATE;
  SELECT * INTO v_target FROM public.sites WHERE id = p_target_site_id FOR UPDATE;

  IF v_source.id IS NULL OR v_target.id IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'code', 'SITE_NOT_FOUND');
  END IF;

  INSERT INTO public.site_memberships (site_id, user_id, role, invited_by_user_id)
  SELECT p_target_site_id, user_id, role, invited_by_user_id
  FROM public.site_memberships
  WHERE site_id = p_source_site_id
  ON CONFLICT (site_id, user_id) DO NOTHING;

  DELETE FROM public.site_memberships WHERE site_id = p_source_site_id;

  UPDATE public.site_subscriptions
  SET site_id = p_target_site_id, updated_at = NOW()
  WHERE site_id = p_source_site_id;

  FOR v_quota IN
    SELECT * FROM public.site_quotas WHERE site_id = p_source_site_id
  LOOP
    INSERT INTO public.site_quotas (
      site_id,
      quota_period_start,
      quota_period_end,
      monthly_included_credits,
      purchased_credits_balance,
      bonus_credits_balance,
      used_credits,
      remaining_credits,
      reset_source
    ) VALUES (
      p_target_site_id,
      v_quota.quota_period_start,
      v_quota.quota_period_end,
      v_quota.monthly_included_credits,
      v_quota.purchased_credits_balance,
      v_quota.bonus_credits_balance,
      v_quota.used_credits,
      v_quota.remaining_credits,
      v_quota.reset_source
    )
    ON CONFLICT (site_id, quota_period_start, quota_period_end) DO UPDATE
    SET
      monthly_included_credits = GREATEST(public.site_quotas.monthly_included_credits, EXCLUDED.monthly_included_credits),
      purchased_credits_balance = public.site_quotas.purchased_credits_balance + EXCLUDED.purchased_credits_balance,
      bonus_credits_balance = public.site_quotas.bonus_credits_balance + EXCLUDED.bonus_credits_balance,
      used_credits = LEAST(
        GREATEST(public.site_quotas.monthly_included_credits, EXCLUDED.monthly_included_credits)
          + public.site_quotas.purchased_credits_balance
          + EXCLUDED.purchased_credits_balance
          + public.site_quotas.bonus_credits_balance
          + EXCLUDED.bonus_credits_balance,
        public.site_quotas.used_credits + EXCLUDED.used_credits
      ),
      remaining_credits = GREATEST(
        (
          GREATEST(public.site_quotas.monthly_included_credits, EXCLUDED.monthly_included_credits)
          + public.site_quotas.purchased_credits_balance
          + EXCLUDED.purchased_credits_balance
          + public.site_quotas.bonus_credits_balance
          + EXCLUDED.bonus_credits_balance
        ) - LEAST(
          GREATEST(public.site_quotas.monthly_included_credits, EXCLUDED.monthly_included_credits)
            + public.site_quotas.purchased_credits_balance
            + EXCLUDED.purchased_credits_balance
            + public.site_quotas.bonus_credits_balance
            + EXCLUDED.bonus_credits_balance,
          public.site_quotas.used_credits + EXCLUDED.used_credits
        ),
        0
      ),
      updated_at = NOW();
  END LOOP;

  DELETE FROM public.site_quotas WHERE site_id = p_source_site_id;

  FOR v_trial IN
    SELECT * FROM public.site_trials WHERE site_id = p_source_site_id
  LOOP
    INSERT INTO public.site_trials (
      site_id,
      trial_type,
      total_trial_credits,
      used_trial_credits,
      status,
      started_at,
      exhausted_at
    ) VALUES (
      p_target_site_id,
      v_trial.trial_type,
      v_trial.total_trial_credits,
      v_trial.used_trial_credits,
      v_trial.status,
      v_trial.started_at,
      v_trial.exhausted_at
    )
    ON CONFLICT DO NOTHING;
  END LOOP;

  DELETE FROM public.site_trials WHERE site_id = p_source_site_id;

  UPDATE public.generation_requests
  SET site_id = p_target_site_id, updated_at = NOW()
  WHERE site_id = p_source_site_id;

  UPDATE public.usage_events
  SET site_id = p_target_site_id
  WHERE site_id = p_source_site_id;

  -- Legacy merge-only update; subscriptions is not part of the runtime billing system.
  UPDATE public.subscriptions
  SET site_id = p_target_site_id, updated_at = NOW()
  WHERE site_id = p_source_site_id;

  UPDATE public.usage_logs
  SET site_hash = v_target.site_hash
  WHERE site_hash = v_source.site_hash;

  UPDATE public.debug_logs
  SET site_hash = v_target.site_hash
  WHERE site_hash = v_source.site_hash;

  UPDATE public.sites
  SET
    status = 'merged',
    merged_into_site_id = p_target_site_id,
    updated_at = NOW()
  WHERE id = p_source_site_id;

  -- Merge-history table; retained for audit purposes only.
  -- Not used by runtime application logic.
  INSERT INTO public.site_merges (
    source_site_id,
    target_site_id,
    merged_by_user_id,
    reason
  ) VALUES (
    p_source_site_id,
    p_target_site_id,
    p_actor_user_id,
    p_reason
  );

  INSERT INTO public.site_audit_logs (
    site_id,
    actor_user_id,
    event_type,
    severity,
    metadata
  ) VALUES (
    p_target_site_id,
    p_actor_user_id,
    'site_merge',
    'warn',
    jsonb_build_object(
      'source_site_id', p_source_site_id,
      'target_site_id', p_target_site_id,
      'reason', p_reason
    )
  );

  INSERT INTO public.usage_events (
    site_id,
    user_id,
    event_type,
    credits_delta,
    idempotency_key,
    metadata
  ) VALUES (
    p_target_site_id,
    p_actor_user_id,
    'site_merge',
    0,
    CONCAT('site-merge:', p_source_site_id::text, ':', p_target_site_id::text),
    jsonb_build_object('source_site_id', p_source_site_id, 'target_site_id', p_target_site_id)
  )
  ON CONFLICT DO NOTHING;

  RETURN jsonb_build_object(
    'ok', TRUE,
    'source_site_id', p_source_site_id,
    'target_site_id', p_target_site_id
  );
END;
$$;

-- ---------------------------------------------------------------------------
-- 6. Intentional omissions
-- ---------------------------------------------------------------------------
-- - no destructive cleanup of legacy tables or columns
-- - no new UNIQUE constraint on sites.site_hash until duplicate production data
--   is audited and cleaned manually
-- - no RLS or policy changes here; the repository does not define them, and
--   adding them blindly could break the working service-role backend path
