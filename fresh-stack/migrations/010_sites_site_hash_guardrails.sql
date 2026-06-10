-- Migration 010: Canonical site hash guardrails
--
-- Runtime code now prefers an existing canonical site row when duplicate
-- site_hash records are present, but the database should still enforce
-- uniqueness once existing duplicates are cleaned up.
--
-- Preflight query:
--   SELECT site_hash, COUNT(*)
--   FROM public.sites
--   WHERE site_hash IS NOT NULL
--   GROUP BY site_hash
--   HAVING COUNT(*) > 1;
--
-- If duplicate rows exist, clean them up first, then rerun the CREATE UNIQUE
-- INDEX statement emitted in the NOTICE below.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.sites
    WHERE site_hash IS NOT NULL
    GROUP BY site_hash
    HAVING COUNT(*) > 1
  ) THEN
    RAISE NOTICE 'Skipping unique site_hash guardrail because duplicate site_hash rows exist. Clean up duplicates first, then run: CREATE UNIQUE INDEX uq_sites_site_hash_guardrail ON public.sites(site_hash) WHERE site_hash IS NOT NULL;';
  ELSIF NOT EXISTS (
    SELECT 1
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'sites'
      AND indexdef ILIKE 'CREATE UNIQUE INDEX%'
      AND indexdef ILIKE '%(site_hash)%'
  ) THEN
    EXECUTE 'CREATE UNIQUE INDEX uq_sites_site_hash_guardrail ON public.sites(site_hash) WHERE site_hash IS NOT NULL';
  END IF;
END $$;
