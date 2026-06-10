-- Migration 015: backward-compatible identity cleanup
--
-- Additive, idempotent. Does not drop, rename, or delete columns.
-- Does not touch quota logic (quota never reads is_internal).
-- Anonymous trial rows/sites (no license) keep license_id NULL.
--
-- Goals:
-- - backfill usage_logs.license_id (from user_id where it is a real
--   licenses.id, then from license_key)
-- - backfill sites.license_id from license_key
-- - add an additive is_internal telemetry flag
-- - add safe reporting views for real user activity
--
-- OPERATIONAL PREREQUISITE:
-- - Take a production database backup BEFORE applying this migration.
--   The UPDATE statements rewrite historical attribution columns; a
--   backup is the rollback path of record.
-- - After deploy, run 015_identity_cleanup_backfill.verify.sql.

SET lock_timeout = '5s';

-- 1. Additive telemetry flag (does NOT affect quota; quota never reads it)
ALTER TABLE public.usage_logs
  ADD COLUMN IF NOT EXISTS is_internal boolean NOT NULL DEFAULT false;

-- 2. Backfill usage_logs.license_id from user_id ONLY where:
--    - license_id is currently NULL
--    - user_id is a real licenses.id (FK-safe; orphans excluded)
UPDATE public.usage_logs ul
SET license_id = ul.user_id
FROM public.licenses l
WHERE ul.license_id IS NULL
  AND ul.user_id IS NOT NULL
  AND l.id = ul.user_id;

-- 3. Backfill usage_logs.license_id from license_key where still NULL
UPDATE public.usage_logs ul
SET license_id = l.id
FROM public.licenses l
WHERE ul.license_id IS NULL
  AND ul.license_key IS NOT NULL
  AND l.license_key = ul.license_key;

-- 4. Backfill sites.license_id from license_key (anonymous trial sites
--    have no license_key, so they correctly keep license_id NULL)
UPDATE public.sites s
SET license_id = l.id
FROM public.licenses l
WHERE s.license_id IS NULL
  AND s.license_key IS NOT NULL
  AND l.license_key = s.license_key;

-- 5. Flag historical internal/test telemetry rows (best-effort, by domain)
UPDATE public.usage_logs
SET is_internal = true
WHERE is_internal = false
  AND COALESCE(domain, site_url, '') ~* '(localhost|tastewp|127\.0\.0|192\.168\.|\.local|\.test|beepbeepaiaudit|live-check|schema-v2|site_verify|example\.com)';

-- 6. Column documentation (clarify semantics; no rename)
COMMENT ON COLUMN public.usage_logs.user_id IS
  'DEPRECATED for new writes. Historically held licenses.id. Use license_id. Retained for backward compatibility and historical rows.';
COMMENT ON COLUMN public.usage_logs.license_id IS
  'FK to licenses.id. Authoritative account attribution for usage. Prefer over user_id.';
COMMENT ON COLUMN public.sites.license_id IS
  'FK to licenses.id. NULL for anonymous trial sites with no linked account.';
COMMENT ON COLUMN public.usage_logs.is_internal IS
  'True for dev/local/TasteWP/internal-test telemetry. Excluded from real-user reporting views. Does not affect quota.';

-- 7. Safe reporting views (real user activity, internal excluded)
CREATE OR REPLACE VIEW public.v_real_user_activity AS
SELECT
  l.id            AS license_id,
  l.email,
  l.plan,
  l.status        AS license_status,
  COUNT(ul.id)                              AS generations,
  SUM(COALESCE(ul.credits_used, 1))         AS credits_used,
  MIN(ul.created_at)                        AS first_generation_at,
  MAX(ul.created_at)                        AS last_generation_at
FROM public.licenses l
JOIN public.usage_logs ul
  ON ul.license_id = l.id
WHERE ul.endpoint = 'api/alt-text'
  AND ul.status   = 'success'
  AND ul.is_internal = false
  AND COALESCE(ul.is_trial, false) = false
GROUP BY l.id, l.email, l.plan, l.status;

CREATE OR REPLACE VIEW public.v_sites_account_linked AS
SELECT
  s.id            AS site_id,
  s.site_hash,
  s.site_url,
  s.canonical_domain,
  s.license_id,
  s.license_key,
  s.owner_user_id,
  l.email         AS account_email,
  l.plan          AS account_plan,
  s.status,
  s.last_seen_at
FROM public.sites s
LEFT JOIN public.licenses l ON l.id = s.license_id
WHERE COALESCE(s.environment, 'production') = 'production'
  AND COALESCE(s.site_url, '') !~* '(localhost|tastewp|beepbeepaiaudit|live-check|schema-v2|site_verify|example\.com)';

CREATE OR REPLACE VIEW public.v_signups_without_generation AS
SELECT l.id AS license_id, l.email, l.plan, l.created_at
FROM public.licenses l
LEFT JOIN public.usage_logs ul
  ON ul.license_id = l.id
 AND ul.endpoint = 'api/alt-text'
 AND ul.status = 'success'
 AND ul.is_internal = false
WHERE ul.id IS NULL;
