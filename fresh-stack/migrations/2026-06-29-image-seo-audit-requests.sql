CREATE TABLE IF NOT EXISTS public.image_seo_audit_requests (
  id UUID PRIMARY KEY,
  email TEXT NOT NULL,
  site_url TEXT NOT NULL,
  normalized_domain TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  score INTEGER,
  pages_scanned INTEGER,
  images_scanned INTEGER,
  summary_json JSONB,
  error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_image_seo_audit_requests_email_created
  ON public.image_seo_audit_requests(email, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_image_seo_audit_requests_domain_created
  ON public.image_seo_audit_requests(normalized_domain, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_image_seo_audit_requests_status_created
  ON public.image_seo_audit_requests(status, created_at DESC);
