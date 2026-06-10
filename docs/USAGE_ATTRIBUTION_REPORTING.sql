-- Usage attribution & reporting queries (safe / copy-paste)
--
-- Notes:
-- - These queries exclude internal/test/dev domains commonly seen in logs.
-- - Customize filters if you have additional internal hostnames.
--
-- Exclude patterns:
-- - localhost
-- - tastewp
-- - beepbeepaiaudit
-- - live-check
-- - schema-v2
-- - site_verify
-- - example.com

-- ---------------------------------------------------------------------------
-- 1) Active production sites (exclude internal/test)
-- ---------------------------------------------------------------------------
SELECT
  s.id,
  s.site_hash,
  s.site_url,
  s.canonical_domain,
  s.owner_user_id,
  s.license_key,
  s.last_seen_at
FROM public.sites s
WHERE s.status = 'active'
  AND COALESCE(s.environment, 'production') = 'production'
  AND COALESCE(s.site_url, '') <> ''
  AND s.site_url !~* '(localhost|tastewp|beepbeepaiaudit|live-check|schema-v2|site_verify|example\.com)'
ORDER BY s.last_seen_at DESC NULLS LAST;

-- ---------------------------------------------------------------------------
-- 2) Usage by user email (license email, since user_id references licenses.id)
-- ---------------------------------------------------------------------------
SELECT
  l.email,
  COUNT(*) AS generations,
  SUM(COALESCE(ul.credits_used, 1)) AS credits_used,
  MAX(ul.created_at) AS last_generation_at
FROM public.usage_logs ul
LEFT JOIN public.licenses l ON l.id = ul.user_id
WHERE ul.endpoint = 'api/alt-text'
  AND ul.status = 'success'
GROUP BY l.email
ORDER BY credits_used DESC NULLS LAST;

-- ---------------------------------------------------------------------------
-- 3) Signup but no generation (license exists, no success alt-text)
-- ---------------------------------------------------------------------------
SELECT
  l.id,
  l.email,
  l.created_at
FROM public.licenses l
LEFT JOIN public.usage_logs ul
  ON ul.user_id = l.id
  AND ul.endpoint = 'api/alt-text'
  AND ul.status = 'success'
WHERE ul.id IS NULL
ORDER BY l.created_at DESC;

-- ---------------------------------------------------------------------------
-- 4) Top sites by credits used (exclude internal/test)
-- ---------------------------------------------------------------------------
SELECT
  ul.site_hash,
  MAX(s.site_url) AS site_url,
  SUM(COALESCE(ul.credits_used, 1)) AS credits_used,
  COUNT(*) AS generations,
  MAX(ul.created_at) AS last_generation_at
FROM public.usage_logs ul
LEFT JOIN public.sites s ON s.site_hash = ul.site_hash
WHERE ul.endpoint = 'api/alt-text'
  AND ul.status = 'success'
  AND COALESCE(s.site_url, '') !~* '(localhost|tastewp|beepbeepaiaudit|live-check|schema-v2|site_verify|example\.com)'
GROUP BY ul.site_hash
ORDER BY credits_used DESC NULLS LAST
LIMIT 200;

-- ---------------------------------------------------------------------------
-- 5) Unknown attribution rows (still missing user_id)
-- ---------------------------------------------------------------------------
SELECT
  ul.id,
  ul.created_at,
  ul.site_hash,
  ul.license_id,
  ul.license_key,
  ul.user_email,
  ul.endpoint,
  ul.status
FROM public.usage_logs ul
WHERE ul.user_id IS NULL
  AND ul.endpoint = 'api/alt-text'
  AND ul.status = 'success'
ORDER BY ul.created_at DESC
LIMIT 500;

