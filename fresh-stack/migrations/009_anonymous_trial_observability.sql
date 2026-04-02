-- Migration 009: Anonymous trial observability hardening
--
-- Keeps the site-owned anonymous trial model intact while adding metadata that
-- makes abuse review and signup continuity easier during legacy fallback mode.

ALTER TABLE IF EXISTS public.trial_usage
  ADD COLUMN IF NOT EXISTS anon_id VARCHAR(128),
  ADD COLUMN IF NOT EXISTS anonymous_risk_key VARCHAR(64),
  ADD COLUMN IF NOT EXISTS ip_hash VARCHAR(64);

CREATE INDEX IF NOT EXISTS idx_trial_usage_anon_id ON public.trial_usage(anon_id);
CREATE INDEX IF NOT EXISTS idx_trial_usage_risk_key ON public.trial_usage(anonymous_risk_key);

ALTER TABLE IF EXISTS public.site_trials
  ALTER COLUMN total_trial_credits SET DEFAULT 5;
