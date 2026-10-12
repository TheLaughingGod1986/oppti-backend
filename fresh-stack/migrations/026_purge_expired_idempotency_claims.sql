-- Housekeeping for generation_idempotency_claims (025). Rows are never needed
-- after expires_at: in_progress rows past expiry are taken over, succeeded
-- rows past expiry are no longer replayed. The backend also sweeps
-- opportunistically on claim; this function lets a scheduled job (pg_cron or
-- an external cron) purge in bounded batches.
CREATE OR REPLACE FUNCTION public.purge_expired_generation_idempotency_claims(
  p_grace INTERVAL DEFAULT INTERVAL '1 hour',
  p_batch INTEGER DEFAULT 5000
) RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_deleted INTEGER;
BEGIN
  WITH doomed AS (
    SELECT scope, idempotency_key
    FROM public.generation_idempotency_claims
    WHERE expires_at < now() - p_grace
    ORDER BY expires_at
    LIMIT GREATEST(p_batch, 1)
    FOR UPDATE SKIP LOCKED
  )
  DELETE FROM public.generation_idempotency_claims c
  USING doomed d
  WHERE c.scope = d.scope AND c.idempotency_key = d.idempotency_key;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;

REVOKE ALL ON FUNCTION public.purge_expired_generation_idempotency_claims(INTERVAL, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.purge_expired_generation_idempotency_claims(INTERVAL, INTEGER) TO service_role;
