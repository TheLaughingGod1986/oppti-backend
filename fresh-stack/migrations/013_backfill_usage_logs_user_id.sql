-- Migration 013: Backfill usage_logs.user_id for attribution
--
-- Goal:
-- - Link historical successful generations to an account user_id wherever possible.
-- - Safe + idempotent: only fills user_id when it is currently NULL.
--
-- Priority:
-- 1) sites.owner_user_id via usage_logs.site_hash
-- 2) licenses.id via usage_logs.license_id (or fallback by license_key join)
--
-- IMPORTANT:
-- - Does not change quota logic, billing logic, or generation logic.
-- - Only updates attribution fields.

-- ---------------------------------------------------------------------------
-- Preview: how many rows can we backfill from sites?
-- ---------------------------------------------------------------------------
SELECT COUNT(*) AS rows_updateable_from_sites
FROM public.usage_logs ul
JOIN public.sites s ON s.site_hash = ul.site_hash
WHERE ul.user_id IS NULL
  AND s.owner_user_id IS NOT NULL
  AND ul.status = 'success'
  AND ul.endpoint = 'api/alt-text';

-- ---------------------------------------------------------------------------
-- Backfill from sites.owner_user_id
-- ---------------------------------------------------------------------------
UPDATE public.usage_logs ul
SET user_id = s.owner_user_id
FROM public.sites s
WHERE ul.user_id IS NULL
  AND ul.site_hash = s.site_hash
  AND s.owner_user_id IS NOT NULL
  AND ul.status = 'success'
  AND ul.endpoint = 'api/alt-text';

-- ---------------------------------------------------------------------------
-- Preview: remaining NULL user_id after sites backfill
-- ---------------------------------------------------------------------------
SELECT COUNT(*) AS rows_still_missing_after_sites
FROM public.usage_logs ul
WHERE ul.user_id IS NULL
  AND ul.status = 'success'
  AND ul.endpoint = 'api/alt-text';

-- ---------------------------------------------------------------------------
-- Preview: how many can be backfilled from licenses (license_id)?
-- ---------------------------------------------------------------------------
SELECT COUNT(*) AS rows_updateable_from_license_id
FROM public.usage_logs ul
WHERE ul.user_id IS NULL
  AND ul.license_id IS NOT NULL
  AND ul.status = 'success'
  AND ul.endpoint = 'api/alt-text';

-- ---------------------------------------------------------------------------
-- Backfill from license_id (licenses.id)
-- ---------------------------------------------------------------------------
UPDATE public.usage_logs ul
SET user_id = ul.license_id
WHERE ul.user_id IS NULL
  AND ul.license_id IS NOT NULL
  AND ul.status = 'success'
  AND ul.endpoint = 'api/alt-text';

-- ---------------------------------------------------------------------------
-- Optional fallback: backfill from license_key -> licenses.id
-- (Only if license_id was not persisted for some rows.)
-- ---------------------------------------------------------------------------
SELECT COUNT(*) AS rows_updateable_from_license_key
FROM public.usage_logs ul
JOIN public.licenses l ON l.license_key = ul.license_key
WHERE ul.user_id IS NULL
  AND ul.license_id IS NULL
  AND ul.license_key IS NOT NULL
  AND ul.status = 'success'
  AND ul.endpoint = 'api/alt-text';

UPDATE public.usage_logs ul
SET user_id = l.id
FROM public.licenses l
WHERE ul.user_id IS NULL
  AND ul.license_id IS NULL
  AND ul.license_key = l.license_key
  AND ul.status = 'success'
  AND ul.endpoint = 'api/alt-text';

-- ---------------------------------------------------------------------------
-- Final check
-- ---------------------------------------------------------------------------
SELECT COUNT(*) AS remaining_null_user_id_success_alt_text
FROM public.usage_logs ul
WHERE ul.user_id IS NULL
  AND ul.status = 'success'
  AND ul.endpoint = 'api/alt-text';

