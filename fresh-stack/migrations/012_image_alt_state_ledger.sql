-- Migration 012: Persistent per-image alt text state ledger
--
-- Purpose:
-- - persist canonical per-image alt text state per site
-- - make dashboard counts queryable from the database
-- - support additive rollout without backfilling all historical images

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS public.image_alt_states (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id UUID NOT NULL REFERENCES public.sites(id) ON DELETE CASCADE,
  attachment_id VARCHAR(255),
  image_ref VARCHAR(255) NOT NULL,
  image_url TEXT,
  current_state VARCHAR(32) NOT NULL DEFAULT 'MISSING',
  alt_text TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_generated_at TIMESTAMPTZ,
  last_reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_image_alt_states_current_state CHECK (
    current_state IN ('MISSING', 'GENERATED', 'NEEDS_REVIEW', 'APPROVED')
  ),
  CONSTRAINT uq_image_alt_states_site_ref UNIQUE (site_id, image_ref)
);

CREATE INDEX IF NOT EXISTS idx_image_alt_states_site_state
  ON public.image_alt_states(site_id, current_state);

CREATE INDEX IF NOT EXISTS idx_image_alt_states_site_attachment
  ON public.image_alt_states(site_id, attachment_id);

CREATE INDEX IF NOT EXISTS idx_image_alt_states_site_updated
  ON public.image_alt_states(site_id, updated_at DESC);
