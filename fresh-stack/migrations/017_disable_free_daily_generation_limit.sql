-- Disable the logged-in Free daily generation cap.
--
-- Migration 016 wrapped bbai_reserve_site_generation with a five-per-day Free
-- reservation cap. That cap was not part of the paid-entitlement incident fix
-- and can leave logged-in plugin users stuck in a generating state when the UI
-- has not opted into the new daily-limit contract.

BEGIN;

DO $$
BEGIN
  IF to_regprocedure(
    'public.bbai_reserve_site_generation_without_free_daily_cap(uuid,uuid,integer,text,text,jsonb,text,integer)'
  ) IS NOT NULL THEN
    DROP FUNCTION IF EXISTS public.bbai_reserve_site_generation(
      UUID, UUID, INTEGER, TEXT, TEXT, JSONB, TEXT, INTEGER
    );

    ALTER FUNCTION public.bbai_reserve_site_generation_without_free_daily_cap(
      UUID, UUID, INTEGER, TEXT, TEXT, JSONB, TEXT, INTEGER
    ) RENAME TO bbai_reserve_site_generation;
  END IF;
END;
$$;

COMMIT;
