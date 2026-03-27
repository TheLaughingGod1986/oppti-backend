-- Cleanup redundant tables (verified orphaned in backend repo)
-- Prefer applying migration 007_drop_confirmed_unused_legacy_objects.sql.
-- Keep this file only as a manual fallback for Supabase SQL Editor.

ALTER TABLE IF EXISTS public.licenses
  DROP COLUMN IF EXISTS tokens_remaining;

DROP TABLE IF EXISTS public.credits CASCADE;

DROP TABLE IF EXISTS public.organization_members CASCADE;
DROP TABLE IF EXISTS public.password_reset_tokens CASCADE;
DROP TABLE IF EXISTS public.users CASCADE;
