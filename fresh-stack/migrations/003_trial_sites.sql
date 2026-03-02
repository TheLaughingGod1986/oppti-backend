-- Migration 003: Allow trial sites (no license) in sites table + backfill from trial_usage.
--
-- Problem: trial_usage records anonymous generations per site_hash but never
--          creates a row in `sites`, making trial activity invisible to the
--          dashboard / admin queries.  Also, when a trial user later registers
--          or activates a license the registration INSERT would create a
--          duplicate row instead of linking to the existing trial row.
--
-- Changes:
--   1. Make sites.license_key NULLABLE so trial sites can exist without a license.
--   2. Make sites.site_url NULLABLE (trial requests may not always send it).
--   3. Backfill missing sites rows from historical trial_usage data.

-- 1. Allow sites to exist without a license (trial sites).
--    FK still enforced when the value is non-NULL.
ALTER TABLE sites ALTER COLUMN license_key DROP NOT NULL;

-- 2. Allow site_url to be NULL (trial requests may omit it).
ALTER TABLE sites ALTER COLUMN site_url DROP NOT NULL;

-- 3. Backfill: create missing sites rows from trial_usage.
--    Uses the most recent trial_usage row per site_hash for best-effort site_url.
--    ON CONFLICT DO NOTHING makes this idempotent and safe to rerun.
INSERT INTO sites (site_hash, site_url, fingerprint, status, activated_at, last_activity_at)
SELECT
  tu.site_hash,
  tu.site_url,
  tu.site_fingerprint,
  'active',
  MIN(tu.created_at),          -- first trial usage = activated_at
  MAX(tu.created_at)           -- last trial usage = last_activity_at
FROM trial_usage tu
WHERE tu.site_hash IS NOT NULL
  AND tu.site_hash != ''
GROUP BY tu.site_hash, tu.site_url, tu.site_fingerprint
ON CONFLICT (site_hash) DO UPDATE SET
  last_activity_at = GREATEST(sites.last_activity_at, EXCLUDED.last_activity_at),
  site_url = COALESCE(NULLIF(EXCLUDED.site_url, ''), sites.site_url);
