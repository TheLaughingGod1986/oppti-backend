-- Post-deploy verification for the restored site-owned quota V2 schema.
-- Safe to run after the repair migration, and again after the optional backfill.

CREATE OR REPLACE FUNCTION pg_temp.bbai_relation_row_count(p_qualified_name TEXT)
RETURNS BIGINT
LANGUAGE plpgsql
AS $$
DECLARE
  v_regclass REGCLASS;
  v_count BIGINT;
BEGIN
  v_regclass := to_regclass(p_qualified_name);
  IF v_regclass IS NULL THEN
    RETURN NULL;
  END IF;

  EXECUTE format('SELECT count(*) FROM %s', v_regclass) INTO v_count;
  RETURN v_count;
END;
$$;

-- 1. Runtime-required V2 relations must now exist; merge-only legacy objects
-- are reported separately for compatibility visibility.
SELECT
  object_name,
  object_type,
  to_regclass(format('public.%I', object_name)) IS NOT NULL AS exists_in_public
FROM (
  VALUES
    ('plans', 'runtime_required_table'),
    ('site_memberships', 'runtime_required_table'),
    ('site_subscriptions', 'runtime_required_table'),
    ('site_quotas', 'runtime_required_table'),
    ('site_trials', 'runtime_required_table'),
    ('generation_requests', 'runtime_required_table'),
    ('usage_events', 'runtime_required_table'),
    ('site_audit_logs', 'runtime_required_table'),
    ('site_merges', 'merge_only_legacy_table')
) AS expected(object_name, object_type)
ORDER BY object_type, object_name;

-- 2. Runtime-required V2 RPC functions must now exist; deprecated merge RPCs
-- are reported separately and do not affect runtime health.
SELECT
  expected.function_name,
  expected.function_type,
  proc.oid IS NOT NULL AS exists_in_public,
  CASE
    WHEN proc.oid IS NOT NULL THEN pg_get_function_identity_arguments(proc.oid)
    ELSE NULL
  END AS identity_arguments
FROM (
  VALUES
    ('bbai_reserve_site_generation', 'runtime_required_rpc'),
    ('bbai_finalize_site_generation', 'runtime_required_rpc'),
    ('bbai_apply_site_billing_event', 'runtime_required_rpc'),
    ('bbai_merge_sites', 'deprecated_merge_rpc')
) AS expected(function_name, function_type)
LEFT JOIN LATERAL (
  SELECT p.oid
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname = expected.function_name
  ORDER BY p.oid
  LIMIT 1
) AS proc ON TRUE
ORDER BY expected.function_type, expected.function_name;

-- 3. 009 anonymous trial observability columns must exist and site_trials
-- should carry the default limit expected by the live backend.
SELECT
  expected.column_name,
  cols.data_type,
  cols.column_default,
  cols.is_nullable,
  cols.column_name IS NOT NULL AS exists_in_public
FROM (
  VALUES
    ('anon_id'),
    ('anonymous_risk_key'),
    ('ip_hash')
) AS expected(column_name)
LEFT JOIN information_schema.columns cols
  ON cols.table_schema = 'public'
 AND cols.table_name = 'trial_usage'
 AND cols.column_name = expected.column_name
ORDER BY expected.column_name;

SELECT
  cols.column_default AS site_trials_total_trial_credits_default
FROM information_schema.columns cols
WHERE cols.table_schema = 'public'
  AND cols.table_name = 'site_trials'
  AND cols.column_name = 'total_trial_credits';

-- 4. The legacy quota trigger must still be present.
SELECT
  trg.tgname AS trigger_name,
  tbl.relname AS table_name,
  fn.proname AS function_name,
  NOT trg.tgisinternal AS is_user_trigger
FROM pg_trigger trg
JOIN pg_class tbl
  ON tbl.oid = trg.tgrelid
JOIN pg_namespace nsp
  ON nsp.oid = tbl.relnamespace
JOIN pg_proc fn
  ON fn.oid = trg.tgfoid
WHERE nsp.nspname = 'public'
  AND trg.tgname = 'trg_update_quota_summary';

-- 5. The backend startup probe should now return SITE_REQUIRED instead of a
-- missing-function error for bbai_reserve_site_generation.
SELECT public.bbai_reserve_site_generation(NULL::uuid) AS reserve_null_site_probe;

-- 6. RLS remains intentionally untouched by this rollout; verify current state
-- for runtime-required tables plus merge-only legacy visibility.
SELECT
  expected.table_name,
  cls.relrowsecurity AS rls_enabled,
  cls.relforcerowsecurity AS rls_forced
FROM (
  VALUES
    ('plans'),
    ('site_memberships'),
    ('site_subscriptions'),
    ('site_quotas'),
    ('site_trials'),
    ('generation_requests'),
    ('usage_events'),
    ('site_audit_logs'),
    ('site_merges')
) AS expected(table_name)
LEFT JOIN pg_class cls
  ON cls.relname = expected.table_name
LEFT JOIN pg_namespace nsp
  ON nsp.oid = cls.relnamespace
WHERE nsp.nspname = 'public' OR nsp.nspname IS NULL
ORDER BY expected.table_name;

-- 7. Key row counts after restore / backfill.
SELECT
  table_name,
  pg_temp.bbai_relation_row_count(format('public.%I', table_name)) AS row_count
FROM (
  VALUES
    ('licenses'),
    ('sites'),
    ('trial_usage'),
    ('usage_logs'),
    ('subscriptions'),
    ('site_memberships'),
    ('site_subscriptions'),
    ('site_quotas'),
    ('site_trials'),
    ('generation_requests'),
    ('usage_events'),
    ('site_audit_logs'),
    ('site_merges')
) AS expected(table_name)
ORDER BY table_name;

-- 8. Operational sanity checks.
WITH active_site_subscriptions AS (
  SELECT DISTINCT ON (ss.site_id)
    ss.site_id,
    COALESCE(ss.current_period_start, date_trunc('month', NOW())) AS quota_period_start,
    COALESCE(ss.current_period_end, date_trunc('month', NOW()) + INTERVAL '1 month') AS quota_period_end
  FROM public.site_subscriptions ss
  WHERE ss.status IN ('active', 'trialing', 'past_due')
  ORDER BY ss.site_id, COALESCE(ss.current_period_end, NOW()) DESC NULLS LAST, ss.updated_at DESC
),
duplicate_site_hashes AS (
  SELECT
    site_hash,
    count(*) AS row_count
  FROM public.sites
  WHERE merged_into_site_id IS NULL
    AND site_hash IS NOT NULL
    AND btrim(site_hash) <> ''
  GROUP BY site_hash
  HAVING count(*) > 1
)
SELECT
  (SELECT count(*) FROM active_site_subscriptions sub
    LEFT JOIN public.site_quotas sq
      ON sq.site_id = sub.site_id
     AND sq.quota_period_start = sub.quota_period_start
     AND sq.quota_period_end = sub.quota_period_end
    WHERE sq.id IS NULL
  ) AS active_site_subscriptions_missing_current_quota,
  (SELECT count(*) FROM duplicate_site_hashes) AS duplicate_site_hash_groups_remaining,
  (SELECT count(DISTINCT tu.site_hash)
   FROM public.trial_usage tu
   WHERE tu.site_hash IS NOT NULL
     AND btrim(tu.site_hash) <> ''
     AND NOT EXISTS (
       SELECT 1
       FROM public.sites s
       WHERE s.site_hash = tu.site_hash
     )
  ) AS trial_hashes_without_any_site_row,
  (SELECT count(*)
   FROM public.subscriptions sub
   WHERE sub.site_id IS NULL
     AND lower(COALESCE(sub.status, '')) IN ('active', 'trialing', 'past_due', 'cancelled', 'canceled')
  ) AS legacy_subscriptions_still_without_site_id;

-- 9. Rolled-back smoke test for reserve/finalize on a throwaway trial site.
BEGIN;

WITH inserted_site AS (
  INSERT INTO public.sites (
    site_hash,
    wp_install_uuid,
    site_url,
    normalized_site_url,
    canonical_domain,
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
  VALUES (
    'verify-site-hash-' || gen_random_uuid()::text,
    'verify-install-' || gen_random_uuid()::text,
    'https://verify.example.invalid',
    'verify.example.invalid',
    'verify.example.invalid',
    'verify-fingerprint-' || gen_random_uuid()::text,
    'verify-fingerprint-' || gen_random_uuid()::text,
    'active',
    NOW(),
    NOW(),
    NOW(),
    NOW(),
    NOW(),
    'production'
  )
  RETURNING id, site_hash
),
reserved AS (
  SELECT public.bbai_reserve_site_generation(
    (SELECT id FROM inserted_site),
    NULL,
    1,
    'verify-idempotency-' || gen_random_uuid()::text,
    'verify-request-' || gen_random_uuid()::text,
    '{"source":"post_deploy_verification"}'::jsonb,
    'trial',
    5
  ) AS reserve_result
),
finalized AS (
  SELECT public.bbai_finalize_site_generation(
    ((SELECT reserve_result FROM reserved) ->> 'generation_request_id')::uuid,
    TRUE,
    '{"source":"post_deploy_verification"}'::jsonb
  ) AS finalize_result
)
SELECT
  (SELECT id FROM inserted_site) AS smoke_site_id,
  (SELECT reserve_result FROM reserved) AS reserve_result,
  (SELECT finalize_result FROM finalized) AS finalize_result;

ROLLBACK;
