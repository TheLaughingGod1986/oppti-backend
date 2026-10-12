-- ============================================================================
-- REVIEW ONLY — NOT YET APPLIED
--
-- Drop exact-duplicate NON-UNIQUE indexes on the OpptiAI Supabase project
-- (femyykcbrleehnyapxbu, eu-west-2).
--
-- Prepared: 2026-06-10, from a read-only audit of live pg_indexes/pg_stat data.
-- Scope guarantees:
--   * Drops ONLY plain (non-unique, non-partial, non-expression) btree indexes.
--   * Every dropped index has a surviving twin on the exact same column.
--   * No table, column, unique index, constraint, or constraint-backed index
--     is touched. Verified against pg_constraint: none of the drop targets
--     backs a constraint.
--   * Idempotent: safe to re-run (DROP INDEX IF EXISTS + guarded preflight).
--
-- Locking note: plain DROP INDEX takes a brief ACCESS EXCLUSIVE lock on the
-- parent table. All four tables are small (< 2 MB); the lock is momentary.
--
-- NOTE: 6 further duplicates found in the same audit were already dropped by
-- someone/something else before this file was written — see Appendix B.
-- ============================================================================


-- ============================================================================
-- STEP 0 — PREFLIGHT (read-only; run this first and eyeball the output)
--
-- Expect 5 rows, one per planned drop, each with:
--   target_exists = true, keeper_exists = true,
--   and both *_def columns showing the same (column) list,
--   keeper_def being UNIQUE for the three unique-keeper cases.
-- If target_exists = false the drop is already done (harmless).
-- If keeper_exists = false DO NOT APPLY — investigate first.
-- ============================================================================

SELECT p.tbl,
       p.drop_idx,
       EXISTS (SELECT 1 FROM pg_indexes i
               WHERE i.schemaname = 'public' AND i.indexname = p.drop_idx) AS target_exists,
       p.keep_idx,
       EXISTS (SELECT 1 FROM pg_indexes i
               WHERE i.schemaname = 'public' AND i.indexname = p.keep_idx) AS keeper_exists,
       (SELECT i.indexdef FROM pg_indexes i
        WHERE i.schemaname = 'public' AND i.indexname = p.drop_idx)        AS target_def,
       (SELECT i.indexdef FROM pg_indexes i
        WHERE i.schemaname = 'public' AND i.indexname = p.keep_idx)        AS keeper_def
FROM (VALUES
    ('sites',         'idx_sites_site_hash',                      'sites_site_hash_unique'),
    ('licenses',      'idx_licenses_license_key',                 'licenses_license_key_key'),
    ('subscriptions', 'idx_subscriptions_stripe_subscription_id', 'subscriptions_stripe_subscription_id_key'),
    ('usage_logs',    'idx_usage_logs_user_id',                   'usage_logs_user_id_idx'),
    ('usage_logs',    'idx_usage_logs_license_id',                'usage_logs_license_id_idx')
) AS p(tbl, drop_idx, keep_idx);


-- ============================================================================
-- STEP 1 — GUARD BLOCK (part of the migration; aborts if anything is off)
--
-- For each pair, before any drop happens this verifies that:
--   1. the keeper index still exists;
--   2. the keeper indexes the same column(s) as the drop target
--      (when the target still exists);
--   3. the drop target is non-unique, not partial, not an expression index,
--      and does not back a constraint.
-- Any failure raises an exception, which rolls back the whole migration.
-- ============================================================================

DO $$
DECLARE
    pair RECORD;
    keep_cols  text;
    drop_cols  text;
    bad        text;
BEGIN
    FOR pair IN
        SELECT * FROM (VALUES
            ('sites',         'idx_sites_site_hash',                      'sites_site_hash_unique'),
            ('licenses',      'idx_licenses_license_key',                 'licenses_license_key_key'),
            ('subscriptions', 'idx_subscriptions_stripe_subscription_id', 'subscriptions_stripe_subscription_id_key'),
            ('usage_logs',    'idx_usage_logs_user_id',                   'usage_logs_user_id_idx'),
            ('usage_logs',    'idx_usage_logs_license_id',                'usage_logs_license_id_idx')
        ) AS t(tbl, drop_idx, keep_idx)
    LOOP
        -- 1. Keeper must exist.
        IF NOT EXISTS (
            SELECT 1 FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public' AND c.relname = pair.keep_idx
        ) THEN
            RAISE EXCEPTION 'ABORT: keeper index public.% is missing; will not drop %',
                pair.keep_idx, pair.drop_idx;
        END IF;

        -- Skip remaining checks if the target is already gone (idempotent re-run).
        IF NOT EXISTS (
            SELECT 1 FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public' AND c.relname = pair.drop_idx
        ) THEN
            RAISE NOTICE 'Skipping %: already dropped.', pair.drop_idx;
            CONTINUE;
        END IF;

        -- 2. Same indexed column list (name-for-name, in order).
        SELECT string_agg(a.attname, ',' ORDER BY k.ord) INTO keep_cols
        FROM pg_index i
        JOIN pg_class c ON c.oid = i.indexrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
        JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
        WHERE n.nspname = 'public' AND c.relname = pair.keep_idx;

        SELECT string_agg(a.attname, ',' ORDER BY k.ord) INTO drop_cols
        FROM pg_index i
        JOIN pg_class c ON c.oid = i.indexrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
        JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
        WHERE n.nspname = 'public' AND c.relname = pair.drop_idx;

        IF keep_cols IS DISTINCT FROM drop_cols THEN
            RAISE EXCEPTION 'ABORT: % indexes (%) but keeper % indexes (%) — not a duplicate',
                pair.drop_idx, drop_cols, pair.keep_idx, keep_cols;
        END IF;

        -- 3. Target must be plain: non-unique, not partial, no expressions,
        --    and not backing any constraint.
        SELECT CASE
                 WHEN i.indisunique                  THEN 'is UNIQUE'
                 WHEN i.indpred IS NOT NULL          THEN 'is partial'
                 WHEN i.indexprs IS NOT NULL         THEN 'is an expression index'
                 WHEN EXISTS (SELECT 1 FROM pg_constraint con
                              WHERE con.conindid = i.indexrelid)
                                                     THEN 'backs a constraint'
                 ELSE NULL
               END INTO bad
        FROM pg_index i
        JOIN pg_class c ON c.oid = i.indexrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = pair.drop_idx;

        IF bad IS NOT NULL THEN
            RAISE EXCEPTION 'ABORT: % % — refusing to drop', pair.drop_idx, bad;
        END IF;
    END LOOP;
END
$$;


-- ============================================================================
-- STEP 2 — THE DROPS (5 statements, each idempotent)
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Table:    public.sites
--    Dropping: idx_sites_site_hash            (non-unique btree on site_hash, 0 scans)
--    Keeping:  sites_site_hash_unique         (UNIQUE btree on site_hash, ~35k scans)
--    Safe because: a unique index on the same single column serves every
--      lookup the non-unique one can, and additionally enforces uniqueness.
--      The dropped index adds write cost with zero read benefit.
--    Rollback: CREATE INDEX idx_sites_site_hash ON public.sites USING btree (site_hash);
-- ----------------------------------------------------------------------------
DROP INDEX IF EXISTS public.idx_sites_site_hash;

-- ----------------------------------------------------------------------------
-- 2. Table:    public.licenses
--    Dropping: idx_licenses_license_key       (non-unique btree on license_key, ~36k scans)
--    Keeping:  licenses_license_key_key       (UNIQUE btree on license_key)
--    Safe because: identical single column; the planner will transparently
--      switch to the unique index for the same lookups (license-key auth
--      lookups are equality probes — identical plans, same or better cost).
--    Rollback: CREATE INDEX idx_licenses_license_key ON public.licenses USING btree (license_key);
-- ----------------------------------------------------------------------------
DROP INDEX IF EXISTS public.idx_licenses_license_key;

-- ----------------------------------------------------------------------------
-- 3. Table:    public.subscriptions
--    Dropping: idx_subscriptions_stripe_subscription_id      (non-unique, 0 scans)
--    Keeping:  subscriptions_stripe_subscription_id_key      (UNIQUE, same column)
--    Safe because: identical single column (stripe_subscription_id); unique
--      keeper covers all reads. Table has 1 row; risk is nil.
--    Rollback: CREATE INDEX idx_subscriptions_stripe_subscription_id ON public.subscriptions USING btree (stripe_subscription_id);
-- ----------------------------------------------------------------------------
DROP INDEX IF EXISTS public.idx_subscriptions_stripe_subscription_id;

-- ----------------------------------------------------------------------------
-- 4. Table:    public.usage_logs
--    Dropping: idx_usage_logs_user_id         (non-unique btree on user_id, 0 scans)
--    Keeping:  usage_logs_user_id_idx         (non-unique btree on user_id, ~288 scans)
--    Safe because: byte-for-byte identical definition (same column, same
--      method, no predicate). Two copies of the same index; one is enough.
--      Keeping the copy the planner has historically chosen.
--    Rollback: CREATE INDEX idx_usage_logs_user_id ON public.usage_logs USING btree (user_id);
-- ----------------------------------------------------------------------------
DROP INDEX IF EXISTS public.idx_usage_logs_user_id;

-- ----------------------------------------------------------------------------
-- 5. Table:    public.usage_logs
--    Dropping: idx_usage_logs_license_id      (non-unique btree on license_id, 0 scans)
--    Keeping:  usage_logs_license_id_idx      (non-unique btree on license_id, ~488 scans)
--    Safe because: byte-for-byte identical definition. Same reasoning as #4.
--    Rollback: CREATE INDEX idx_usage_logs_license_id ON public.usage_logs USING btree (license_id);
-- ----------------------------------------------------------------------------
DROP INDEX IF EXISTS public.idx_usage_logs_license_id;


-- ============================================================================
-- APPENDIX A — FULL ROLLBACK (recreates all 5, in one place)
--
-- On a live database prefer CREATE INDEX CONCURRENTLY (cannot run inside a
-- transaction block); plain CREATE INDEX is fine at current table sizes.
-- ============================================================================
-- CREATE INDEX IF NOT EXISTS idx_sites_site_hash                      ON public.sites         USING btree (site_hash);
-- CREATE INDEX IF NOT EXISTS idx_licenses_license_key                 ON public.licenses      USING btree (license_key);
-- CREATE INDEX IF NOT EXISTS idx_subscriptions_stripe_subscription_id ON public.subscriptions USING btree (stripe_subscription_id);
-- CREATE INDEX IF NOT EXISTS idx_usage_logs_user_id                   ON public.usage_logs    USING btree (user_id);
-- CREATE INDEX IF NOT EXISTS idx_usage_logs_license_id                ON public.usage_logs    USING btree (license_id);


-- ============================================================================
-- APPENDIX B — duplicates that were ALREADY dropped externally on 2026-06-10
-- (between the read-only audit and the writing of this file; not part of this
-- migration). Original definitions, should any need recreating:
-- ============================================================================
-- CREATE INDEX idx_license_sites_license_id ON public.sites         USING btree (license_id);   -- twin kept: idx_sites_license_id
-- CREATE INDEX idx_license_sites_site_hash  ON public.sites         USING btree (site_hash);    -- twin kept: sites_site_hash_unique
-- CREATE INDEX sites_license_id_idx         ON public.sites         USING btree (license_id);   -- twin kept: idx_sites_license_id
-- CREATE INDEX sites_license_key_idx        ON public.sites         USING btree (license_key);  -- twin kept: idx_sites_license_key
-- CREATE INDEX licenses_user_id_idx         ON public.licenses      USING btree (user_id);      -- twin kept: idx_licenses_user_id
-- CREATE INDEX subscriptions_user_id_idx    ON public.subscriptions USING btree (user_id);      -- twin kept: idx_subscriptions_user_id


-- ============================================================================
-- STEP 3 — POST-CHECK (read-only; run after applying)
-- Expect: 0 rows (no remaining exact-duplicate non-unique index pairs).
-- ============================================================================

SELECT i1.tablename, i1.indexname AS dup_a, i2.indexname AS dup_b
FROM pg_indexes i1
JOIN pg_indexes i2
  ON  i1.schemaname = i2.schemaname
  AND i1.tablename  = i2.tablename
  AND i1.indexname  < i2.indexname
  AND replace(i1.indexdef, i1.indexname, '') = replace(i2.indexdef, i2.indexname, '')
WHERE i1.schemaname = 'public'
  AND i1.indexdef NOT LIKE 'CREATE UNIQUE%'
  AND i2.indexdef NOT LIKE 'CREATE UNIQUE%';
