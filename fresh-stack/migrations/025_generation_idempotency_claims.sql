-- Claim an Idempotency-Key atomically BEFORE the credit hold, so two concurrent
-- same-key alt-text requests cannot both reserve and be charged.
-- The PRIMARY KEY is the atomic claim: the second INSERT fails with 23505.
CREATE TABLE IF NOT EXISTS public.generation_idempotency_claims (
  scope TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  endpoint TEXT NOT NULL DEFAULT 'api/alt-text',
  status TEXT NOT NULL DEFAULT 'in_progress',
  owner_request_id TEXT,
  response_status INTEGER,
  response_body JSONB,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT pk_generation_idempotency_claims PRIMARY KEY (scope, idempotency_key),
  CONSTRAINT chk_generation_idempotency_claims_status CHECK (status IN ('in_progress', 'succeeded'))
);

CREATE INDEX IF NOT EXISTS idx_generation_idempotency_claims_expires
  ON public.generation_idempotency_claims(expires_at);

ALTER TABLE public.generation_idempotency_claims ENABLE ROW LEVEL SECURITY;
-- No policies: only the service role (backend) reads/writes this table.
