-- Optional backfill for the restored site-owned quota V2 schema.
--
-- Intentional scope:
-- - create missing trial-owned site rows from legacy trial_usage when no site exists yet
-- - backfill deterministic site ownership pointers and memberships
-- - backfill site_subscriptions only when legacy mapping is explicit or unambiguous
-- - backfill current-period site_quotas and site_trials only when site ownership is
--   unambiguous enough to avoid inventing relationships
--
-- Intentional non-goals:
-- - do not synthesize historical generation_requests
-- - do not synthesize per-request usage_events from legacy usage_logs / trial_usage
-- - do not merge duplicate sites or add a UNIQUE constraint to sites.site_hash

SET lock_timeout = '5s';
SET statement_timeout = '0';

-- ---------------------------------------------------------------------------
-- 1. Backfill missing site rows from legacy anonymous trial traffic
-- ---------------------------------------------------------------------------

WITH trial_rollup AS (
  SELECT
    tu.site_hash,
    min(tu.created_at) AS first_seen_at,
    max(tu.created_at) AS last_seen_at,
    (
      array_agg(NULLIF(tu.site_url, '') ORDER BY tu.created_at DESC)
      FILTER (WHERE NULLIF(tu.site_url, '') IS NOT NULL)
    )[1] AS latest_site_url,
    (
      array_agg(NULLIF(tu.site_fingerprint, '') ORDER BY tu.created_at DESC)
      FILTER (WHERE NULLIF(tu.site_fingerprint, '') IS NOT NULL)
    )[1] AS latest_site_fingerprint
  FROM public.trial_usage tu
  WHERE tu.site_hash IS NOT NULL
    AND btrim(tu.site_hash) <> ''
  GROUP BY tu.site_hash
)
INSERT INTO public.sites (
  site_hash,
  wp_install_uuid,
  site_url,
  fingerprint,
  site_fingerprint,
  status,
  activated_at,
  last_activity_at,
  first_seen_at,
  last_seen_at,
  updated_at,
  environment
)
SELECT
  tr.site_hash,
  tr.site_hash,
  tr.latest_site_url,
  tr.latest_site_fingerprint,
  tr.latest_site_fingerprint,
  'active',
  tr.first_seen_at,
  tr.last_seen_at,
  tr.first_seen_at,
  tr.last_seen_at,
  NOW(),
  'production'
FROM trial_rollup tr
WHERE NOT EXISTS (
  SELECT 1
  FROM public.sites s
  WHERE s.site_hash = tr.site_hash
);

-- ---------------------------------------------------------------------------
-- 2. Backfill deterministic site ownership pointers and memberships
-- ---------------------------------------------------------------------------

UPDATE public.sites s
SET
  owner_user_id = l.id,
  updated_at = NOW()
FROM public.licenses l
WHERE s.owner_user_id IS NULL
  AND s.license_key IS NOT NULL
  AND l.license_key = s.license_key;

INSERT INTO public.site_memberships (site_id, user_id, role, invited_by_user_id)
SELECT
  s.id,
  l.id,
  CASE WHEN s.owner_user_id = l.id THEN 'owner' ELSE 'member' END,
  l.id
FROM public.sites s
JOIN public.licenses l
  ON l.license_key = s.license_key
WHERE s.merged_into_site_id IS NULL
ON CONFLICT (site_id, user_id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 3. Backfill site-owned subscriptions from legacy subscriptions safely
-- ---------------------------------------------------------------------------

WITH active_sites AS (
  SELECT
    s.id,
    s.license_key,
    s.merged_into_site_id
  FROM public.sites s
  WHERE s.merged_into_site_id IS NULL
),
license_site_counts AS (
  SELECT
    license_key,
    count(*) AS active_site_count,
    array_agg(id ORDER BY id) AS active_site_ids
  FROM active_sites
  WHERE license_key IS NOT NULL
  GROUP BY license_key
),
subscription_candidates AS (
  SELECT
    sub.id AS legacy_subscription_id,
    COALESCE(explicit_site.merged_into_site_id, explicit_site.id, lic.active_site_ids[1]) AS mapped_site_id,
    CASE lower(COALESCE(sub.plan, 'free'))
      WHEN 'growth' THEN 'pro'
      WHEN 'pro' THEN 'pro'
      WHEN 'agency' THEN 'agency'
      WHEN 'credits' THEN 'credits'
      ELSE 'free'
    END AS normalized_plan_id,
    CASE lower(COALESCE(sub.status, 'active'))
      WHEN 'trialing' THEN 'trialing'
      WHEN 'past_due' THEN 'past_due'
      WHEN 'cancelled' THEN 'canceled'
      WHEN 'canceled' THEN 'canceled'
      WHEN 'incomplete' THEN 'incomplete'
      WHEN 'incomplete_expired' THEN 'incomplete_expired'
      ELSE 'active'
    END AS normalized_status,
    CASE
      WHEN sub.current_period_start IS NOT NULL
        AND sub.current_period_end IS NOT NULL
        AND sub.current_period_end >= sub.current_period_start + INTERVAL '330 days' THEN 'year'
      WHEN sub.current_period_start IS NOT NULL
        AND sub.current_period_end IS NOT NULL
        AND sub.current_period_end >= sub.current_period_start + INTERVAL '25 days' THEN 'month'
      WHEN lower(COALESCE(sub.plan, 'free')) = 'credits' THEN 'one_time'
      ELSE 'month'
    END AS normalized_billing_interval,
    sub.stripe_customer_id,
    sub.stripe_subscription_id,
    sub.current_period_start,
    sub.current_period_end,
    COALESCE(sub.cancel_at_period_end, FALSE) AS cancel_at_period_end
  FROM public.subscriptions sub
  LEFT JOIN public.sites explicit_site
    ON explicit_site.id = sub.site_id
  LEFT JOIN license_site_counts lic
    ON lic.license_key = sub.license_key
   AND lic.active_site_count = 1
  WHERE lower(COALESCE(sub.status, '')) IN (
    'active',
    'trialing',
    'past_due',
    'cancelled',
    'canceled',
    'incomplete',
    'incomplete_expired'
  )
)
INSERT INTO public.site_subscriptions (
  site_id,
  plan_id,
  stripe_customer_id,
  stripe_subscription_id,
  status,
  billing_interval,
  current_period_start,
  current_period_end,
  cancel_at_period_end,
  updated_at
)
SELECT
  sc.mapped_site_id,
  sc.normalized_plan_id,
  sc.stripe_customer_id,
  sc.stripe_subscription_id,
  sc.normalized_status,
  sc.normalized_billing_interval,
  sc.current_period_start,
  sc.current_period_end,
  sc.cancel_at_period_end,
  NOW()
FROM subscription_candidates sc
WHERE sc.mapped_site_id IS NOT NULL
ON CONFLICT (stripe_subscription_id) DO UPDATE
SET
  site_id = EXCLUDED.site_id,
  plan_id = EXCLUDED.plan_id,
  stripe_customer_id = EXCLUDED.stripe_customer_id,
  status = EXCLUDED.status,
  billing_interval = EXCLUDED.billing_interval,
  current_period_start = EXCLUDED.current_period_start,
  current_period_end = EXCLUDED.current_period_end,
  cancel_at_period_end = EXCLUDED.cancel_at_period_end,
  updated_at = NOW();

WITH active_sites AS (
  SELECT id, license_key
  FROM public.sites
  WHERE merged_into_site_id IS NULL
),
license_site_counts AS (
  SELECT
    license_key,
    count(*) AS active_site_count,
    array_agg(id ORDER BY id) AS active_site_ids
  FROM active_sites
  WHERE license_key IS NOT NULL
  GROUP BY license_key
),
subscription_candidates AS (
  SELECT
    sub.id AS legacy_subscription_id,
    COALESCE(explicit_site.merged_into_site_id, explicit_site.id, lic.active_site_ids[1]) AS mapped_site_id
  FROM public.subscriptions sub
  LEFT JOIN public.sites explicit_site
    ON explicit_site.id = sub.site_id
  LEFT JOIN license_site_counts lic
    ON lic.license_key = sub.license_key
   AND lic.active_site_count = 1
  WHERE sub.site_id IS NULL
    AND lower(COALESCE(sub.status, '')) IN (
      'active',
      'trialing',
      'past_due',
      'cancelled',
      'canceled',
      'incomplete',
      'incomplete_expired'
    )
)
UPDATE public.subscriptions sub
SET
  site_id = sc.mapped_site_id,
  updated_at = NOW()
FROM subscription_candidates sc
WHERE sub.id = sc.legacy_subscription_id
  AND sc.mapped_site_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 4. Backfill current-period site_quotas conservatively
-- ---------------------------------------------------------------------------

WITH active_sites AS (
  SELECT
    s.id,
    s.license_key,
    s.site_hash,
    s.merged_into_site_id
  FROM public.sites s
  WHERE s.merged_into_site_id IS NULL
),
unique_site_hashes AS (
  SELECT
    site_hash,
    min(id) AS site_id
  FROM active_sites
  WHERE site_hash IS NOT NULL
    AND btrim(site_hash) <> ''
  GROUP BY site_hash
  HAVING count(*) = 1
),
license_site_counts AS (
  SELECT
    license_key,
    count(*) AS active_site_count
  FROM active_sites
  WHERE license_key IS NOT NULL
  GROUP BY license_key
),
latest_active_subscription AS (
  SELECT DISTINCT ON (ss.site_id)
    ss.site_id,
    ss.plan_id,
    ss.current_period_start,
    ss.current_period_end,
    ss.status
  FROM public.site_subscriptions ss
  WHERE ss.status IN ('active', 'trialing', 'past_due')
  ORDER BY ss.site_id, COALESCE(ss.current_period_end, NOW()) DESC NULLS LAST, ss.updated_at DESC, ss.created_at DESC
),
quota_candidates AS (
  SELECT
    s.id AS site_id,
    s.site_hash,
    s.license_key,
    (ush.site_id IS NOT NULL) AS can_map_by_site_hash,
    COALESCE(lsc.active_site_count = 1, FALSE) AS can_map_by_license,
    COALESCE(sub.current_period_start, date_trunc('month', NOW())) AS quota_period_start,
    COALESCE(sub.current_period_end, date_trunc('month', NOW()) + INTERVAL '1 month') AS quota_period_end,
    COALESCE(
      sub.plan_id,
      CASE lower(COALESCE(l.plan, 'free'))
        WHEN 'growth' THEN 'pro'
        WHEN 'pro' THEN 'pro'
        WHEN 'agency' THEN 'agency'
        WHEN 'credits' THEN 'credits'
        ELSE 'free'
      END
    ) AS effective_plan_id,
    CASE
      WHEN sub.site_id IS NOT NULL THEN 'subscription_period'
      WHEN ush.site_id IS NOT NULL THEN 'legacy_usage_backfill_site_hash'
      WHEN COALESCE(lsc.active_site_count = 1, FALSE) THEN 'legacy_usage_backfill_license'
      ELSE 'legacy_usage_backfill_skipped'
    END AS reset_source
  FROM active_sites s
  LEFT JOIN unique_site_hashes ush
    ON ush.site_id = s.id
  LEFT JOIN license_site_counts lsc
    ON lsc.license_key = s.license_key
  LEFT JOIN public.licenses l
    ON l.license_key = s.license_key
  LEFT JOIN latest_active_subscription sub
    ON sub.site_id = s.id
),
usage_by_unique_site_hash AS (
  SELECT
    qc.site_id,
    COALESCE(sum(ul.credits_used), 0)::INTEGER AS used_credits
  FROM quota_candidates qc
  JOIN public.usage_logs ul
    ON ul.site_hash = qc.site_hash
   AND ul.created_at >= qc.quota_period_start
   AND ul.created_at < qc.quota_period_end
  WHERE qc.can_map_by_site_hash
  GROUP BY qc.site_id
),
usage_by_unique_license AS (
  SELECT
    qc.site_id,
    COALESCE(sum(ul.credits_used), 0)::INTEGER AS used_credits
  FROM quota_candidates qc
  JOIN public.usage_logs ul
    ON ul.license_key = qc.license_key
   AND ul.created_at >= qc.quota_period_start
   AND ul.created_at < qc.quota_period_end
  WHERE qc.can_map_by_license
    AND NOT qc.can_map_by_site_hash
    AND qc.license_key IS NOT NULL
  GROUP BY qc.site_id
),
resolved_quota_backfill AS (
  SELECT
    qc.site_id,
    qc.quota_period_start,
    qc.quota_period_end,
    CASE qc.effective_plan_id
      WHEN 'pro' THEN 1000
      WHEN 'agency' THEN 10000
      WHEN 'credits' THEN 0
      ELSE 50
    END AS monthly_included_credits,
    CASE
      WHEN qc.can_map_by_site_hash THEN COALESCE(ush.used_credits, 0)
      WHEN qc.can_map_by_license THEN COALESCE(ulc.used_credits, 0)
      ELSE NULL
    END AS used_credits,
    qc.reset_source
  FROM quota_candidates qc
  LEFT JOIN usage_by_unique_site_hash ush
    ON ush.site_id = qc.site_id
  LEFT JOIN usage_by_unique_license ulc
    ON ulc.site_id = qc.site_id
)
INSERT INTO public.site_quotas (
  site_id,
  quota_period_start,
  quota_period_end,
  monthly_included_credits,
  purchased_credits_balance,
  bonus_credits_balance,
  used_credits,
  remaining_credits,
  reset_source
)
SELECT
  rqb.site_id,
  rqb.quota_period_start,
  rqb.quota_period_end,
  rqb.monthly_included_credits,
  0,
  0,
  rqb.used_credits,
  GREATEST(rqb.monthly_included_credits - rqb.used_credits, 0),
  rqb.reset_source
FROM resolved_quota_backfill rqb
WHERE rqb.used_credits IS NOT NULL
ON CONFLICT (site_id, quota_period_start, quota_period_end) DO UPDATE
SET
  monthly_included_credits = GREATEST(public.site_quotas.monthly_included_credits, EXCLUDED.monthly_included_credits),
  used_credits = GREATEST(public.site_quotas.used_credits, EXCLUDED.used_credits),
  remaining_credits = GREATEST(
    (
      GREATEST(public.site_quotas.monthly_included_credits, EXCLUDED.monthly_included_credits)
      + public.site_quotas.purchased_credits_balance
      + public.site_quotas.bonus_credits_balance
    ) - GREATEST(public.site_quotas.used_credits, EXCLUDED.used_credits),
    0
  ),
  reset_source = EXCLUDED.reset_source,
  updated_at = NOW();

-- ---------------------------------------------------------------------------
-- 5. Backfill site_trials from trial_usage only when site_hash maps uniquely
-- ---------------------------------------------------------------------------

WITH active_sites AS (
  SELECT
    s.id,
    s.site_hash
  FROM public.sites s
  WHERE s.merged_into_site_id IS NULL
),
unique_site_hashes AS (
  SELECT
    site_hash,
    min(id) AS site_id
  FROM active_sites
  WHERE site_hash IS NOT NULL
    AND btrim(site_hash) <> ''
  GROUP BY site_hash
  HAVING count(*) = 1
),
ranked_trial_usage AS (
  SELECT
    ush.site_id,
    tu.created_at,
    row_number() OVER (
      PARTITION BY ush.site_id
      ORDER BY tu.created_at, tu.id
    ) AS usage_rank
  FROM public.trial_usage tu
  JOIN unique_site_hashes ush
    ON ush.site_hash = tu.site_hash
),
trial_backfill AS (
  SELECT
    rtu.site_id,
    5 AS total_trial_credits,
    LEAST(count(*), 5)::INTEGER AS used_trial_credits,
    CASE WHEN count(*) >= 5 THEN 'exhausted' ELSE 'active' END AS status,
    min(rtu.created_at) AS started_at,
    min(rtu.created_at) FILTER (WHERE rtu.usage_rank = 5) AS exhausted_at
  FROM ranked_trial_usage rtu
  GROUP BY rtu.site_id
)
INSERT INTO public.site_trials (
  site_id,
  trial_type,
  total_trial_credits,
  used_trial_credits,
  status,
  started_at,
  exhausted_at
)
SELECT
  tb.site_id,
  'initial',
  tb.total_trial_credits,
  tb.used_trial_credits,
  tb.status,
  tb.started_at,
  tb.exhausted_at
FROM trial_backfill tb
WHERE NOT EXISTS (
  SELECT 1
  FROM public.site_trials st
  WHERE st.site_id = tb.site_id
    AND st.trial_type = 'initial'
);

-- ---------------------------------------------------------------------------
-- 6. Backfill summary and explicit skips
-- ---------------------------------------------------------------------------
-- Historical generation_requests and per-request usage_events are intentionally
-- not reconstructed here. Legacy trial_usage and usage_logs do not contain the
-- reservation / finalization lifecycle, idempotency keys, or always-safe site
-- ownership needed to synthesize atomic V2 request history.

WITH active_sites AS (
  SELECT
    s.id,
    s.license_key,
    s.site_hash
  FROM public.sites s
  WHERE s.merged_into_site_id IS NULL
),
unique_site_hashes AS (
  SELECT site_hash
  FROM active_sites
  WHERE site_hash IS NOT NULL
    AND btrim(site_hash) <> ''
  GROUP BY site_hash
  HAVING count(*) = 1
),
license_site_counts AS (
  SELECT
    license_key,
    count(*) AS active_site_count
  FROM active_sites
  WHERE license_key IS NOT NULL
  GROUP BY license_key
),
quota_backfill_candidates AS (
  SELECT
    s.id,
    (s.site_hash IN (SELECT site_hash FROM unique_site_hashes)) AS can_map_by_site_hash,
    COALESCE(lsc.active_site_count = 1, FALSE) AS can_map_by_license
  FROM active_sites s
  LEFT JOIN license_site_counts lsc
    ON lsc.license_key = s.license_key
),
subscription_candidates AS (
  SELECT
    sub.id,
    COALESCE(explicit_site.merged_into_site_id, explicit_site.id, lic.active_site_ids[1]) AS mapped_site_id
  FROM public.subscriptions sub
  LEFT JOIN public.sites explicit_site
    ON explicit_site.id = sub.site_id
  LEFT JOIN (
    SELECT
      license_key,
      count(*) AS active_site_count,
      array_agg(id ORDER BY id) AS active_site_ids
    FROM active_sites
    WHERE license_key IS NOT NULL
    GROUP BY license_key
  ) lic
    ON lic.license_key = sub.license_key
   AND lic.active_site_count = 1
  WHERE lower(COALESCE(sub.status, '')) IN (
    'active',
    'trialing',
    'past_due',
    'cancelled',
    'canceled',
    'incomplete',
    'incomplete_expired'
  )
)
SELECT
  (SELECT count(*) FROM public.sites) AS total_sites_after_backfill,
  (SELECT count(*) FROM public.site_memberships) AS total_site_memberships_after_backfill,
  (SELECT count(*) FROM public.site_subscriptions) AS total_site_subscriptions_after_backfill,
  (SELECT count(*) FROM public.site_quotas) AS total_site_quotas_after_backfill,
  (SELECT count(*) FROM public.site_trials) AS total_site_trials_after_backfill,
  (SELECT count(*) FROM quota_backfill_candidates WHERE NOT (can_map_by_site_hash OR can_map_by_license)) AS sites_skipped_quota_backfill_due_to_ambiguity,
  (SELECT count(*) FROM subscription_candidates WHERE mapped_site_id IS NULL) AS legacy_subscriptions_skipped_due_to_ambiguity;
