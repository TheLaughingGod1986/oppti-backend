-- Migration 20260608120000: shared-wallet title & meta generation support
--
-- Title/meta generation reuses the SAME credit wallet as alt-text
-- (public.site_quotas + the bbai_reserve_site_generation RPC). There is no
-- separate title pool: a credit spent on titles reduces what's available for
-- alt-text and vice versa.
--
-- This migration is therefore additive-only — it tags the shared ledger tables
-- with a `feature_type` column so usage can be attributed per feature in
-- reporting. Existing rows default to 'alt_text', preserving their meaning.
-- The alt-text reservation path, tables, and RPCs are untouched.

SET lock_timeout = '5s';
SET statement_timeout = '0';

-- ---------------------------------------------------------------------------
-- feature_type on the shared ledger tables
-- ---------------------------------------------------------------------------

ALTER TABLE IF EXISTS public.usage_logs
  ADD COLUMN IF NOT EXISTS feature_type VARCHAR(32) NOT NULL DEFAULT 'alt_text';

ALTER TABLE IF EXISTS public.generation_requests
  ADD COLUMN IF NOT EXISTS feature_type VARCHAR(32) NOT NULL DEFAULT 'alt_text';

ALTER TABLE IF EXISTS public.usage_events
  ADD COLUMN IF NOT EXISTS feature_type VARCHAR(32) NOT NULL DEFAULT 'alt_text';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'generation_requests' AND column_name = 'feature_type'
  ) THEN
    BEGIN
      ALTER TABLE public.generation_requests
        DROP CONSTRAINT IF EXISTS chk_generation_requests_feature;
      ALTER TABLE public.generation_requests
        ADD CONSTRAINT chk_generation_requests_feature
        CHECK (feature_type IN ('alt_text', 'title_meta'));
    EXCEPTION
      WHEN duplicate_object THEN NULL;
    END;
  END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS idx_usage_logs_feature_type_created_at
  ON public.usage_logs(feature_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_generation_requests_feature_type_site
  ON public.generation_requests(site_id, feature_type, created_at DESC);
