-- Optimizer events: history facts (milestones + wins) recorded at audit
-- completion so their timestamps are accurate and reads are cheap. Powers the
-- Progress screen's Milestones row and Recent wins. Applied to production
-- 2026-07-06 via Supabase MCP (create_optimizer_events).
CREATE TABLE IF NOT EXISTS public.optimizer_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  site_hash TEXT NOT NULL,
  type TEXT NOT NULL,          -- 'milestone' | 'win'
  key TEXT NOT NULL,           -- idempotency scope within a site
  label TEXT NOT NULL,
  detail TEXT,
  points_delta INTEGER,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One row per (site, key): milestones fire once; wins use per-audit keys.
CREATE UNIQUE INDEX IF NOT EXISTS uq_optimizer_events_site_key
  ON public.optimizer_events(site_hash, key);

CREATE INDEX IF NOT EXISTS idx_optimizer_events_site_type_created
  ON public.optimizer_events(site_hash, type, created_at DESC);

-- Backend uses the service role (bypasses RLS); no anon/authenticated access.
ALTER TABLE public.optimizer_events ENABLE ROW LEVEL SECURITY;
