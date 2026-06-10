-- Migration 014: usage_logs telemetry refactor
--
-- Additive, idempotent migration for production analytics and abuse review.
-- Safe to run multiple times. Does not drop, rename, or delete existing data.

-- Anonymous trial generations have no license key. Relax the legacy constraint
-- without changing existing values; NULL still satisfies the existing FK.
ALTER TABLE public.usage_logs
ALTER COLUMN license_key DROP NOT NULL;

ALTER TABLE public.usage_logs
ADD COLUMN IF NOT EXISTS site_url TEXT,
ADD COLUMN IF NOT EXISTS domain TEXT,
ADD COLUMN IF NOT EXISTS wp_version TEXT,
ADD COLUMN IF NOT EXISTS php_version TEXT,
ADD COLUMN IF NOT EXISTS event_type TEXT,
ADD COLUMN IF NOT EXISTS image_count INTEGER DEFAULT 1,
ADD COLUMN IF NOT EXISTS is_trial BOOLEAN DEFAULT false,
ADD COLUMN IF NOT EXISTS install_hash TEXT,
ADD COLUMN IF NOT EXISTS auth_state TEXT,
ADD COLUMN IF NOT EXISTS plan_key TEXT,
ADD COLUMN IF NOT EXISTS request_source TEXT,
ADD COLUMN IF NOT EXISTS user_agent TEXT,
ADD COLUMN IF NOT EXISTS request_id TEXT,
ADD COLUMN IF NOT EXISTS generation_batch_id TEXT,
ADD COLUMN IF NOT EXISTS plugin_channel TEXT,
ADD COLUMN IF NOT EXISTS environment TEXT;

-- Additional telemetry fields used by the shared logging service when present.
ALTER TABLE public.usage_logs
ADD COLUMN IF NOT EXISTS image_id TEXT;

CREATE INDEX IF NOT EXISTS idx_usage_logs_created_at
ON public.usage_logs(created_at);

CREATE INDEX IF NOT EXISTS idx_usage_logs_user_id
ON public.usage_logs(user_id);

CREATE INDEX IF NOT EXISTS idx_usage_logs_site_hash
ON public.usage_logs(site_hash);

CREATE INDEX IF NOT EXISTS idx_usage_logs_install_hash
ON public.usage_logs(install_hash);

CREATE INDEX IF NOT EXISTS idx_usage_logs_domain
ON public.usage_logs(domain);

CREATE INDEX IF NOT EXISTS idx_usage_logs_event_type
ON public.usage_logs(event_type);

CREATE INDEX IF NOT EXISTS idx_usage_logs_is_trial
ON public.usage_logs(is_trial);

CREATE INDEX IF NOT EXISTS idx_usage_logs_auth_state
ON public.usage_logs(auth_state);

CREATE INDEX IF NOT EXISTS idx_usage_logs_created_user
ON public.usage_logs(created_at, user_id);

CREATE INDEX IF NOT EXISTS idx_usage_logs_created_site
ON public.usage_logs(created_at, site_hash);

UPDATE public.usage_logs
SET image_count = 1
WHERE image_count IS NULL;

UPDATE public.usage_logs
SET event_type = COALESCE(event_type, endpoint, 'generation')
WHERE event_type IS NULL;

UPDATE public.usage_logs
SET is_trial = true
WHERE is_trial IS NULL
AND user_id IS NULL;

UPDATE public.usage_logs
SET auth_state = 'guest_trial'
WHERE auth_state IS NULL
AND user_id IS NULL;

-- PostgreSQL applies DEFAULT false to existing rows when this column is added.
-- Treat that default as unpopulated for anonymous legacy rows.
UPDATE public.usage_logs
SET is_trial = true
WHERE user_id IS NULL
AND auth_state = 'guest_trial'
AND is_trial = false;

UPDATE public.usage_logs
SET auth_state = 'authenticated_unknown'
WHERE auth_state IS NULL
AND user_id IS NOT NULL;

UPDATE public.usage_logs
SET request_source = 'wordpress_plugin'
WHERE request_source IS NULL;
