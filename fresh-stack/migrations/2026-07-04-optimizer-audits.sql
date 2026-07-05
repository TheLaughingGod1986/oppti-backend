-- Optimizer audit persistence: history for the Progress screen and audit
-- results that survive restarts/instances. Applied to production 2026-07-04
-- via Supabase MCP (create_optimizer_audits).
CREATE TABLE IF NOT EXISTS public.optimizer_audits (
  id UUID PRIMARY KEY,
  site_hash TEXT,
  site_url TEXT NOT NULL,
  normalized_domain TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  overall_score INTEGER,
  pages_scanned INTEGER,
  images_scanned INTEGER,
  result_json JSONB,
  error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_optimizer_audits_site_hash_created
  ON public.optimizer_audits(site_hash, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_optimizer_audits_domain_created
  ON public.optimizer_audits(normalized_domain, created_at DESC);

-- Backend uses the service role (bypasses RLS); no anon/authenticated access.
ALTER TABLE public.optimizer_audits ENABLE ROW LEVEL SECURITY;
