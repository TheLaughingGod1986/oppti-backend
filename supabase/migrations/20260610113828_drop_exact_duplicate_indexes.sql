-- Migration 019: drop exact duplicate non-unique indexes
--
-- STATUS: PREPARED FOR REVIEW ONLY. DO NOT APPLY WITHOUT SIGN-OFF.
--
-- Source of truth: live pg_catalog discovery query run on 2026-06-10 against
-- the production Supabase project. Two indexes are treated as exact duplicates
-- only when table, access method, key columns, operator classes, sort options,
-- expressions, and partial predicates all match, and BOTH are non-unique,
-- non-primary, and not backed by any pg_constraint row (PK/UNIQUE/FK/EXCLUDE).
--
-- Scope guarantees:
--   * No table, column, unique index, primary key, or constraint-backed index
--     is touched.
--   * Every dropped index has an identical, valid twin that remains, so query
--     plans and FK lookups keep exactly the same index coverage.
--   * The kept name is always the one asserted by repo migrations
--     (001/008/014 use CREATE INDEX IF NOT EXISTS idx_*), so re-running old
--     migrations remains a no-op and cannot resurrect the duplicates.
--
-- Safety mechanics:
--   * Each drop is re-verified against pg_catalog at execution time. If a pair
--     no longer matches exactly (or the kept twin is missing/invalid), the
--     migration RAISES and the whole transaction rolls back -- nothing is
--     dropped on a stale assumption.
--   * Already-dropped indexes are skipped with a NOTICE, so the migration is
--     idempotent and safe to re-run.
--   * lock_timeout = '5s' bounds the ACCESS EXCLUSIVE lock wait per table.
--
-- ============================================================================
-- PAIRS DROPPED BY THIS MIGRATION (transactional; low-write tables only)
-- ============================================================================
--
-- 1) table:    public.dashboard_sessions
--    dropping: dashboard_sessions_license_key_idx
--    keeping:  idx_dashboard_sessions_license
--    why safe: identical btree(license_key); auto-named duplicate of the
--              documented canonical index; non-unique, not constraint-backed.
--    rollback: CREATE INDEX IF NOT EXISTS dashboard_sessions_license_key_idx
--                ON public.dashboard_sessions (license_key);
--
-- 2) table:    public.debug_logs
--    dropping: debug_logs_license_key_idx
--    keeping:  idx_debug_logs_license
--    why safe: identical btree(license_key); duplicate of the canonical index
--              created by 001_initial_schema.sql; non-unique, not
--              constraint-backed.
--    rollback: CREATE INDEX IF NOT EXISTS debug_logs_license_key_idx
--                ON public.debug_logs (license_key);
--
-- 3) table:    public.licenses
--    dropping: licenses_user_id_idx
--    keeping:  idx_licenses_user_id
--    why safe: identical btree(user_id); the kept index preserves user_id
--              lookup coverage; non-unique, not constraint-backed.
--    rollback: CREATE INDEX IF NOT EXISTS licenses_user_id_idx
--                ON public.licenses (user_id);
--
-- 4) table:    public.sites
--    dropping: idx_license_sites_license_id
--    keeping:  idx_sites_license_id
--    why safe: btree(license_id) exists in THREE identical copies on this
--              table; this is the first of two drops, keeping one copy.
--              Non-unique, not constraint-backed.
--    rollback: CREATE INDEX IF NOT EXISTS idx_license_sites_license_id
--                ON public.sites (license_id);
--
-- 5) table:    public.sites
--    dropping: sites_license_id_idx
--    keeping:  idx_sites_license_id
--    why safe: second identical btree(license_id) copy (see pair 4).
--    rollback: CREATE INDEX IF NOT EXISTS sites_license_id_idx
--                ON public.sites (license_id);
--
-- 6) table:    public.sites
--    dropping: sites_license_key_idx
--    keeping:  idx_sites_license_key
--    why safe: identical btree(license_key); duplicate of the canonical index
--              created by 001_initial_schema.sql; non-unique, not
--              constraint-backed.
--    rollback: CREATE INDEX IF NOT EXISTS sites_license_key_idx
--                ON public.sites (license_key);
--
-- 7) table:    public.sites
--    dropping: idx_license_sites_site_hash
--    keeping:  idx_sites_site_hash
--    why safe: identical btree(site_hash); duplicate of the canonical index
--              created by 001_initial_schema.sql. NOTE: the unique partial
--              guardrail uq_sites_site_hash_guardrail is intentionally NOT
--              touched -- it enforces behaviour and is out of scope.
--    rollback: CREATE INDEX IF NOT EXISTS idx_license_sites_site_hash
--                ON public.sites (site_hash);
--
-- 8) table:    public.subscriptions
--    dropping: subscriptions_user_id_idx
--    keeping:  idx_subscriptions_user_id
--    why safe: identical btree(user_id); non-unique, not constraint-backed.
--    rollback: CREATE INDEX IF NOT EXISTS subscriptions_user_id_idx
--                ON public.subscriptions (user_id);
--
-- ============================================================================

SET lock_timeout = '5s';
SET statement_timeout = '60s';

DO $$
DECLARE
  pair RECORD;
  v_verified BOOLEAN;
BEGIN
  FOR pair IN
    SELECT * FROM (VALUES
      ('dashboard_sessions', 'dashboard_sessions_license_key_idx', 'idx_dashboard_sessions_license'),
      ('debug_logs',         'debug_logs_license_key_idx',         'idx_debug_logs_license'),
      ('licenses',           'licenses_user_id_idx',               'idx_licenses_user_id'),
      ('sites',              'idx_license_sites_license_id',       'idx_sites_license_id'),
      ('sites',              'sites_license_id_idx',               'idx_sites_license_id'),
      ('sites',              'sites_license_key_idx',              'idx_sites_license_key'),
      ('sites',              'idx_license_sites_site_hash',        'idx_sites_site_hash'),
      ('subscriptions',      'subscriptions_user_id_idx',          'idx_subscriptions_user_id')
    ) AS p(table_name, drop_index, keep_index)
  LOOP
    -- Idempotency: skip pairs whose duplicate is already gone.
    IF NOT EXISTS (
      SELECT 1
      FROM pg_class i
      JOIN pg_namespace n ON n.oid = i.relnamespace
      WHERE n.nspname = 'public'
        AND i.relname = pair.drop_index
        AND i.relkind = 'i'
    ) THEN
      RAISE NOTICE 'SKIP: public.% does not exist (already dropped?)', pair.drop_index;
      CONTINUE;
    END IF;

    -- Preflight: re-verify the pair is STILL an exact duplicate and safe.
    SELECT EXISTS (
      SELECT 1
      FROM pg_index xd
      JOIN pg_class id    ON id.oid = xd.indexrelid
      JOIN pg_index xk    ON xk.indrelid = xd.indrelid
      JOIN pg_class ik    ON ik.oid = xk.indexrelid
      JOIN pg_class t     ON t.oid = xd.indrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = 'public'
        AND t.relname  = pair.table_name
        AND id.relname = pair.drop_index
        AND ik.relname = pair.keep_index
        -- exact structural match
        AND id.relam = ik.relam
        AND xd.indkey::text    = xk.indkey::text
        AND xd.indclass::text  = xk.indclass::text
        AND xd.indoption::text = xk.indoption::text
        AND COALESCE(pg_get_expr(xd.indexprs, xd.indrelid), '')
          = COALESCE(pg_get_expr(xk.indexprs, xk.indrelid), '')
        AND COALESCE(pg_get_expr(xd.indpred, xd.indrelid), '')
          = COALESCE(pg_get_expr(xk.indpred, xk.indrelid), '')
        -- safety: both non-unique, non-primary; the kept twin must be valid
        AND NOT xd.indisunique  AND NOT xk.indisunique
        AND NOT xd.indisprimary AND NOT xk.indisprimary
        AND xk.indisvalid
        -- safety: neither index backs a constraint (PK/UNIQUE/FK/EXCLUDE)
        AND NOT EXISTS (
          SELECT 1 FROM pg_constraint c
          WHERE c.conindid IN (xd.indexrelid, xk.indexrelid)
        )
    ) INTO v_verified;

    IF NOT v_verified THEN
      RAISE EXCEPTION
        'ABORT: public.% / public.% on table public.% failed exact-duplicate verification; transaction rolled back, nothing dropped',
        pair.drop_index, pair.keep_index, pair.table_name;
    END IF;

    EXECUTE format('DROP INDEX public.%I', pair.drop_index);
    RAISE NOTICE 'DROPPED public.% (kept identical public.%)', pair.drop_index, pair.keep_index;
  END LOOP;
END;
$$;

-- ============================================================================
-- HOT TABLE: public.usage_logs -- EXCLUDED FROM THIS MIGRATION
-- ============================================================================
--
-- usage_logs receives a write on every generation request, so a transactional
-- DROP INDEX (ACCESS EXCLUSIVE lock) is not appropriate. Run the following
-- MANUALLY via psql during a quiet window. DROP INDEX CONCURRENTLY cannot run
-- inside a transaction block, so these must be executed as standalone
-- statements (not via this migration runner).
--
-- 9) table:    public.usage_logs
--    dropping: usage_logs_user_id_idx
--    keeping:  idx_usage_logs_user_id  (created by migration 014)
--    why safe: identical btree(user_id); non-unique, not constraint-backed.
--
--      DROP INDEX CONCURRENTLY IF EXISTS public.usage_logs_user_id_idx;
--
--    rollback:
--      CREATE INDEX CONCURRENTLY IF NOT EXISTS usage_logs_user_id_idx
--        ON public.usage_logs (user_id);
--
-- 10) table:   public.usage_logs
--     dropping: usage_logs_license_id_idx
--     keeping:  idx_usage_logs_license_id  (created by migration 008)
--     why safe: identical btree(license_id); non-unique, not constraint-backed.
--
--      DROP INDEX CONCURRENTLY IF EXISTS public.usage_logs_license_id_idx;
--
--     rollback:
--      CREATE INDEX CONCURRENTLY IF NOT EXISTS usage_logs_license_id_idx
--        ON public.usage_logs (license_id);
--
-- Before running each manual drop, re-run the duplicate verification:
--
--   SELECT pg_get_indexdef(x.indexrelid)
--   FROM pg_index x
--   JOIN pg_class i ON i.oid = x.indexrelid
--   WHERE i.relname IN ('usage_logs_user_id_idx',  'idx_usage_logs_user_id',
--                       'usage_logs_license_id_idx','idx_usage_logs_license_id')
--     AND NOT x.indisunique
--     AND NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conindid = x.indexrelid);
--
-- ============================================================================
-- FULL ROLLBACK (recreate every index dropped by this migration)
-- ============================================================================
--
--   CREATE INDEX IF NOT EXISTS dashboard_sessions_license_key_idx ON public.dashboard_sessions (license_key);
--   CREATE INDEX IF NOT EXISTS debug_logs_license_key_idx         ON public.debug_logs (license_key);
--   CREATE INDEX IF NOT EXISTS licenses_user_id_idx               ON public.licenses (user_id);
--   CREATE INDEX IF NOT EXISTS idx_license_sites_license_id       ON public.sites (license_id);
--   CREATE INDEX IF NOT EXISTS sites_license_id_idx               ON public.sites (license_id);
--   CREATE INDEX IF NOT EXISTS sites_license_key_idx              ON public.sites (license_key);
--   CREATE INDEX IF NOT EXISTS idx_license_sites_site_hash        ON public.sites (site_hash);
--   CREATE INDEX IF NOT EXISTS subscriptions_user_id_idx          ON public.subscriptions (user_id);
--
-- (usage_logs rollbacks are listed with their manual drops above; use
--  CREATE INDEX CONCURRENTLY when recreating on the hot table.)
