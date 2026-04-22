-- Preflight diagnostics for restoring the missing site-owned quota V2 schema.
-- Read-only apart from pg_temp helper functions created for this session.

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

CREATE OR REPLACE FUNCTION pg_temp.bbai_relation_size_bytes(p_qualified_name TEXT)
RETURNS BIGINT
LANGUAGE sql
AS $$
  SELECT CASE
    WHEN to_regclass(p_qualified_name) IS NULL THEN NULL
    ELSE pg_total_relation_size(to_regclass(p_qualified_name))
  END;
$$;

CREATE OR REPLACE FUNCTION pg_temp.bbai_query_count(p_sql TEXT)
RETURNS BIGINT
LANGUAGE plpgsql
AS $$
DECLARE
  v_count BIGINT;
BEGIN
  EXECUTE p_sql INTO v_count;
  RETURN v_count;
END;
$$;

-- 1. Runtime-required V2 relations plus merge-only legacy helpers retained for
-- compatibility visibility.
SELECT
  object_name,
  object_type,
  to_regclass(format('public.%I', object_name)) IS NOT NULL AS exists_in_public
FROM (
  VALUES
    ('plans', 'v2_table'),
    ('site_memberships', 'v2_table'),
    ('site_subscriptions', 'v2_table'),
    ('site_quotas', 'v2_table'),
    ('site_trials', 'v2_table'),
    ('generation_requests', 'v2_table'),
    ('usage_events', 'v2_table'),
    ('site_audit_logs', 'v2_table'),
    ('site_merges', 'merge_only_legacy_table'),
    ('subscriptions', 'legacy_helper_table')
) AS expected(object_name, object_type)
ORDER BY object_type, object_name;

-- 2. Runtime-required V2 RPC functions plus deprecated merge compatibility RPCs.
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

-- 3. Row Level Security state for runtime-required V2 tables plus merge-only
-- legacy visibility.
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

-- 4. Legacy table row counts and approximate sizes.
SELECT
  table_name,
  pg_temp.bbai_relation_row_count(format('public.%I', table_name)) AS row_count,
  pg_size_pretty(pg_temp.bbai_relation_size_bytes(format('public.%I', table_name))) AS total_size
FROM (
  VALUES
    ('licenses'),
    ('sites'),
    ('trial_usage'),
    ('usage_logs'),
    ('quota_summaries'),
    ('subscriptions'),
    ('debug_logs')
) AS legacy(table_name)
ORDER BY table_name;

-- 5. V2 table row counts and approximate sizes, if present.
SELECT
  table_name,
  pg_temp.bbai_relation_row_count(format('public.%I', table_name)) AS row_count,
  pg_size_pretty(pg_temp.bbai_relation_size_bytes(format('public.%I', table_name))) AS total_size
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
) AS v2(table_name)
ORDER BY table_name;

-- 6. Existing uniqueness enforcement touching sites.site_hash.
SELECT
  'constraint' AS source,
  con.conname AS object_name,
  pg_get_constraintdef(con.oid) AS definition
FROM pg_constraint con
JOIN pg_class rel
  ON rel.oid = con.conrelid
JOIN pg_namespace nsp
  ON nsp.oid = rel.relnamespace
WHERE nsp.nspname = 'public'
  AND rel.relname = 'sites'
  AND con.contype IN ('p', 'u')
  AND pg_get_constraintdef(con.oid) ILIKE '%site_hash%'
UNION ALL
SELECT
  'index' AS source,
  idx.indexname AS object_name,
  idx.indexdef AS definition
FROM pg_indexes idx
WHERE idx.schemaname = 'public'
  AND idx.tablename = 'sites'
  AND idx.indexdef ILIKE '%site_hash%'
  AND idx.indexdef ILIKE '%UNIQUE%'
ORDER BY source, object_name;

-- 7. Duplicate site_hash overview across currently active/unmerged sites.
WITH site_rows AS (
  SELECT
    s.id,
    s.license_key,
    s.site_hash,
    s.site_url,
    s.status,
    to_jsonb(s) ->> 'merged_into_site_id' AS merged_into_site_id,
    COALESCE(
      NULLIF(to_jsonb(s) ->> 'created_at', '')::timestamptz,
      NULLIF(to_jsonb(s) ->> 'first_seen_at', '')::timestamptz,
      NULLIF(to_jsonb(s) ->> 'activated_at', '')::timestamptz,
      NULLIF(to_jsonb(s) ->> 'last_activity_at', '')::timestamptz,
      NULLIF(to_jsonb(s) ->> 'updated_at', '')::timestamptz,
      NULLIF(to_jsonb(s) ->> 'deactivated_at', '')::timestamptz
    ) AS first_observed_at,
    COALESCE(
      NULLIF(to_jsonb(s) ->> 'updated_at', '')::timestamptz,
      NULLIF(to_jsonb(s) ->> 'last_seen_at', '')::timestamptz,
      NULLIF(to_jsonb(s) ->> 'last_activity_at', '')::timestamptz,
      NULLIF(to_jsonb(s) ->> 'deactivated_at', '')::timestamptz,
      NULLIF(to_jsonb(s) ->> 'created_at', '')::timestamptz,
      NULLIF(to_jsonb(s) ->> 'activated_at', '')::timestamptz
    ) AS last_observed_at
  FROM public.sites s
),
active_site_rows AS (
  SELECT *
  FROM site_rows
  WHERE COALESCE(merged_into_site_id, '') = ''
),
duplicate_site_hashes AS (
  SELECT
    site_hash,
    count(*) AS row_count,
    count(DISTINCT license_key) FILTER (WHERE license_key IS NOT NULL) AS distinct_license_keys,
    min(first_observed_at) AS oldest_seen_at,
    max(last_observed_at) AS newest_seen_at,
    array_agg(id ORDER BY first_observed_at NULLS LAST, id) AS site_ids
  FROM active_site_rows
  WHERE site_hash IS NOT NULL
    AND btrim(site_hash) <> ''
  GROUP BY site_hash
  HAVING count(*) > 1
)
SELECT
  count(*) AS duplicate_site_hash_groups,
  COALESCE(sum(row_count), 0) AS rows_in_duplicate_groups,
  COALESCE(sum(row_count - 1), 0) AS excess_rows_beyond_one_per_hash
FROM duplicate_site_hashes;

-- 8. Duplicate site_hash detail showing oldest/newest surviving rows per hash.
WITH site_rows AS (
  SELECT
    s.id,
    s.license_key,
    s.site_hash,
    s.site_url,
    s.status,
    to_jsonb(s) ->> 'merged_into_site_id' AS merged_into_site_id,
    COALESCE(
      NULLIF(to_jsonb(s) ->> 'created_at', '')::timestamptz,
      NULLIF(to_jsonb(s) ->> 'first_seen_at', '')::timestamptz,
      NULLIF(to_jsonb(s) ->> 'activated_at', '')::timestamptz,
      NULLIF(to_jsonb(s) ->> 'last_activity_at', '')::timestamptz,
      NULLIF(to_jsonb(s) ->> 'updated_at', '')::timestamptz,
      NULLIF(to_jsonb(s) ->> 'deactivated_at', '')::timestamptz
    ) AS first_observed_at,
    COALESCE(
      NULLIF(to_jsonb(s) ->> 'updated_at', '')::timestamptz,
      NULLIF(to_jsonb(s) ->> 'last_seen_at', '')::timestamptz,
      NULLIF(to_jsonb(s) ->> 'last_activity_at', '')::timestamptz,
      NULLIF(to_jsonb(s) ->> 'deactivated_at', '')::timestamptz,
      NULLIF(to_jsonb(s) ->> 'created_at', '')::timestamptz,
      NULLIF(to_jsonb(s) ->> 'activated_at', '')::timestamptz
    ) AS last_observed_at
  FROM public.sites s
),
active_site_rows AS (
  SELECT *
  FROM site_rows
  WHERE COALESCE(merged_into_site_id, '') = ''
),
duplicate_site_hashes AS (
  SELECT
    site_hash,
    count(*) AS row_count
  FROM active_site_rows
  WHERE site_hash IS NOT NULL
    AND btrim(site_hash) <> ''
  GROUP BY site_hash
  HAVING count(*) > 1
)
SELECT
  d.site_hash,
  d.row_count,
  (
    jsonb_agg(
      jsonb_build_object(
        'id', a.id,
        'license_key', a.license_key,
        'status', a.status,
        'site_url', a.site_url,
        'first_observed_at', a.first_observed_at,
        'last_observed_at', a.last_observed_at
      )
      ORDER BY a.first_observed_at NULLS LAST, a.id
    ) -> 0
  ) AS oldest_row,
  (
    jsonb_agg(
      jsonb_build_object(
        'id', a.id,
        'license_key', a.license_key,
        'status', a.status,
        'site_url', a.site_url,
        'first_observed_at', a.first_observed_at,
        'last_observed_at', a.last_observed_at
      )
      ORDER BY a.last_observed_at DESC NULLS LAST, a.id DESC
    ) -> 0
  ) AS newest_row,
  array_agg(a.id ORDER BY a.first_observed_at NULLS LAST, a.id) AS all_site_ids
FROM duplicate_site_hashes d
JOIN active_site_rows a
  ON a.site_hash = d.site_hash
GROUP BY d.site_hash, d.row_count
ORDER BY d.row_count DESC, d.site_hash;

-- 9. Relationship integrity and backfill blockers.
SELECT
  check_name,
  orphan_or_unmapped_count
FROM (
  SELECT
    'sites.license_key without matching licenses row' AS check_name,
    count(*)::BIGINT AS orphan_or_unmapped_count
  FROM public.sites s
  LEFT JOIN public.licenses l
    ON l.license_key = s.license_key
  WHERE s.license_key IS NOT NULL
    AND l.license_key IS NULL

  UNION ALL

  SELECT
    'sites.owner_user_id without matching licenses row' AS check_name,
    count(*)::BIGINT AS orphan_or_unmapped_count
  FROM public.sites s
  LEFT JOIN public.licenses l
    ON l.id::text = to_jsonb(s) ->> 'owner_user_id'
  WHERE NULLIF(to_jsonb(s) ->> 'owner_user_id', '') IS NOT NULL
    AND l.id IS NULL

  UNION ALL

  SELECT
    'subscriptions.license_key without matching licenses row' AS check_name,
    CASE
      WHEN to_regclass('public.subscriptions') IS NULL THEN NULL
      ELSE pg_temp.bbai_query_count($sql$
        SELECT count(*)::BIGINT
        FROM public.subscriptions sub
        LEFT JOIN public.licenses l
          ON l.license_key = sub.license_key
        WHERE sub.license_key IS NOT NULL
          AND l.license_key IS NULL
      $sql$)
    END AS orphan_or_unmapped_count

  UNION ALL

  SELECT
    'subscriptions.site_id without matching sites row' AS check_name,
    CASE
      WHEN to_regclass('public.subscriptions') IS NULL THEN NULL
      ELSE pg_temp.bbai_query_count($sql$
        SELECT count(*)::BIGINT
        FROM public.subscriptions sub
        LEFT JOIN public.sites s
          ON s.id = sub.site_id
        WHERE sub.site_id IS NOT NULL
          AND s.id IS NULL
      $sql$)
    END AS orphan_or_unmapped_count

  UNION ALL

  SELECT
    'legacy subscriptions with NULL site_id and active-ish status' AS check_name,
    CASE
      WHEN to_regclass('public.subscriptions') IS NULL THEN NULL
      ELSE pg_temp.bbai_query_count($sql$
        SELECT count(*)::BIGINT
        FROM public.subscriptions sub
        WHERE sub.site_id IS NULL
          AND lower(COALESCE(sub.status, '')) IN ('active', 'trialing', 'past_due', 'cancelled', 'canceled')
      $sql$)
    END AS orphan_or_unmapped_count
) AS checks
ORDER BY check_name;

-- 10. Detail for legacy subscriptions that cannot be mapped cleanly by license_key alone.
DO $$
BEGIN
  IF to_regclass('pg_temp.bbai_unmapped_subscription_detail') IS NOT NULL THEN
    EXECUTE 'DROP TABLE pg_temp.bbai_unmapped_subscription_detail';
  END IF;
END;
$$;

CREATE TEMP TABLE bbai_unmapped_subscription_detail (
  subscription_id UUID,
  license_key VARCHAR(255),
  site_id UUID,
  status VARCHAR(50),
  plan VARCHAR(50),
  active_site_count BIGINT,
  active_site_ids UUID[]
) ON COMMIT DROP;

DO $$
BEGIN
  IF to_regclass('public.subscriptions') IS NOT NULL THEN
    EXECUTE $sql$
      WITH active_sites AS (
        SELECT
          s.id,
          s.license_key
        FROM public.sites s
        WHERE COALESCE(to_jsonb(s) ->> 'merged_into_site_id', '') = ''
      ),
      license_site_counts AS (
        SELECT
          license_key,
          count(*)::BIGINT AS active_site_count,
          array_agg(id ORDER BY id) AS active_site_ids
        FROM active_sites
        WHERE license_key IS NOT NULL
        GROUP BY license_key
      )
      INSERT INTO pg_temp.bbai_unmapped_subscription_detail (
        subscription_id,
        license_key,
        site_id,
        status,
        plan,
        active_site_count,
        active_site_ids
      )
      SELECT
        sub.id,
        sub.license_key,
        sub.site_id,
        sub.status,
        sub.plan,
        lic.active_site_count,
        lic.active_site_ids
      FROM public.subscriptions sub
      LEFT JOIN license_site_counts lic
        ON lic.license_key = sub.license_key
      WHERE sub.site_id IS NULL
        AND lower(COALESCE(sub.status, '')) IN ('active', 'trialing', 'past_due', 'cancelled', 'canceled')
      ORDER BY COALESCE(lic.active_site_count, 0) DESC, sub.id
    $sql$;
  END IF;
END;
$$;

SELECT *
FROM pg_temp.bbai_unmapped_subscription_detail
ORDER BY COALESCE(active_site_count, 0) DESC, subscription_id;
