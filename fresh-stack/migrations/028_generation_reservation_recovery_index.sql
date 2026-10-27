-- Supports bounded orphan-reservation recovery without scanning settled history.
-- Apply outside a transaction (CONCURRENTLY), before enabling the new worker.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_generation_requests_reserved_created
  ON public.generation_requests (created_at)
  WHERE status = 'reserved';
