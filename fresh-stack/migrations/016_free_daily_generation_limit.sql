-- Free plan daily generation reservations.
--
-- The application exposes completed successful usage as the customer-facing
-- daily count. This wrapper also considers in-flight reservations while a
-- generation is running, preventing simultaneous requests from exceeding five
-- successful Free generations within one UTC daily reset period. Failed
-- requests are released by bbai_finalize_site_generation and free the slot.

BEGIN;

DO $$
BEGIN
  IF to_regprocedure(
    'public.bbai_reserve_site_generation_without_free_daily_cap(uuid,uuid,integer,text,text,jsonb,text,integer)'
  ) IS NULL THEN
    ALTER FUNCTION public.bbai_reserve_site_generation(
      UUID, UUID, INTEGER, TEXT, TEXT, JSONB, TEXT, INTEGER
    ) RENAME TO bbai_reserve_site_generation_without_free_daily_cap;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.bbai_reserve_site_generation(
  p_site_id UUID,
  p_user_id UUID DEFAULT NULL,
  p_credits INTEGER DEFAULT 1,
  p_idempotency_key TEXT DEFAULT NULL,
  p_request_fingerprint TEXT DEFAULT NULL,
  p_request_metadata JSONB DEFAULT '{}'::jsonb,
  p_quota_mode TEXT DEFAULT 'site',
  p_trial_credits INTEGER DEFAULT 5
) RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  v_existing public.generation_requests%ROWTYPE;
  v_quota_mode TEXT := COALESCE(NULLIF(p_quota_mode, ''), 'site');
  v_plan_id TEXT := 'free';
  v_credits INTEGER := GREATEST(COALESCE(p_credits, 1), 1);
  v_daily_limit INTEGER := 5;
  v_daily_used INTEGER := 0;
  v_daily_start TIMESTAMPTZ;
  v_daily_end TIMESTAMPTZ;
BEGIN
  IF p_site_id IS NULL OR v_quota_mode <> 'site' THEN
    RETURN public.bbai_reserve_site_generation_without_free_daily_cap(
      p_site_id,
      p_user_id,
      p_credits,
      p_idempotency_key,
      p_request_fingerprint,
      p_request_metadata,
      p_quota_mode,
      p_trial_credits
    );
  END IF;

  -- Preserve the existing RPC's idempotency contract even after the daily
  -- window is full: replayed requests return the original reservation.
  IF p_idempotency_key IS NOT NULL THEN
    SELECT *
    INTO v_existing
    FROM public.generation_requests
    WHERE idempotency_key = p_idempotency_key
    LIMIT 1;

    IF FOUND THEN
      RETURN public.bbai_reserve_site_generation_without_free_daily_cap(
        p_site_id, p_user_id, p_credits, p_idempotency_key,
        p_request_fingerprint, p_request_metadata, p_quota_mode, p_trial_credits
      );
    END IF;
  END IF;

  IF p_request_fingerprint IS NOT NULL THEN
    SELECT *
    INTO v_existing
    FROM public.generation_requests
    WHERE site_id = p_site_id
      AND request_fingerprint = p_request_fingerprint
      AND status IN ('reserved', 'succeeded')
      AND created_at >= NOW() - INTERVAL '2 minutes'
    ORDER BY created_at DESC
    LIMIT 1;

    IF FOUND THEN
      RETURN public.bbai_reserve_site_generation_without_free_daily_cap(
        p_site_id, p_user_id, p_credits, p_idempotency_key,
        p_request_fingerprint, p_request_metadata, p_quota_mode, p_trial_credits
      );
    END IF;
  END IF;

  SELECT COALESCE(plan_id, 'free')
  INTO v_plan_id
  FROM public.site_subscriptions
  WHERE site_id = p_site_id
    AND status IN ('active', 'trialing', 'past_due')
  ORDER BY COALESCE(current_period_end, NOW()) DESC NULLS LAST
  LIMIT 1;

  IF COALESCE(v_plan_id, 'free') = 'free' THEN
    v_daily_start := date_trunc('day', NOW() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
    v_daily_end := v_daily_start + INTERVAL '1 day';

    -- Serialize Free reservations for this site and daily window.
    PERFORM pg_advisory_xact_lock(
      hashtextextended('bbai-free-daily:' || p_site_id::text || ':' || v_daily_start::text, 0)
    );

    SELECT COALESCE(SUM(credits_reserved), 0)::INTEGER
    INTO v_daily_used
    FROM public.generation_requests
    WHERE site_id = p_site_id
      AND quota_source = 'site_quota'
      AND status IN ('reserved', 'succeeded')
      AND created_at >= v_daily_start
      AND created_at < v_daily_end;

    IF (v_daily_used + v_credits) > v_daily_limit THEN
      RETURN jsonb_build_object(
        'ok', FALSE,
        'code', 'DAILY_QUOTA_EXCEEDED',
        'daily_generation_limit', v_daily_limit,
        'daily_generations_used', LEAST(v_daily_used, v_daily_limit),
        'daily_generations_remaining', GREATEST(v_daily_limit - v_daily_used, 0),
        'daily_reset_date', v_daily_end
      );
    END IF;
  END IF;

  RETURN public.bbai_reserve_site_generation_without_free_daily_cap(
    p_site_id,
    p_user_id,
    p_credits,
    p_idempotency_key,
    p_request_fingerprint,
    p_request_metadata,
    p_quota_mode,
    p_trial_credits
  );
END;
$$;

COMMIT;
