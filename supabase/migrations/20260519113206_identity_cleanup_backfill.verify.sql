-- Post-deploy verification for 20260519113206_identity_cleanup_backfill.sql
--
-- Run these AFTER the migration is applied to production and the updated
-- backend code is deployed. They are read-only.
--
-- Expected after a successful deploy:
-- - still_misfiled_user_id_rows: 0 (only orphaned historical user_ids may
--   remain; those have no matching licenses.id and are intentionally left)
-- - attributed_rows: should be >= the pre-migration license_id count
-- - internal_rows: > 0 once dev/TasteWP rows are flagged
-- - linked_sites: should equal the number of sites with a license_key

-- 1) usage_logs attribution health
SELECT
  COUNT(*) FILTER (WHERE license_id IS NULL AND user_id IS NOT NULL) AS still_misfiled_user_id_rows,
  COUNT(*) FILTER (WHERE license_id IS NOT NULL)                     AS attributed_rows,
  COUNT(*) FILTER (WHERE is_internal = true)                         AS internal_rows
FROM public.usage_logs;

-- 2) sites linked to a license account
SELECT
  COUNT(*) AS linked_sites
FROM public.sites
WHERE license_id IS NOT NULL;
