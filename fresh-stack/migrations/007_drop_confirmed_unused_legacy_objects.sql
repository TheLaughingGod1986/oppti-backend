-- Migration 007: Final sweep for confirmed unused legacy objects
--
-- Idempotent cleanup for legacy schema objects that have no live backend
-- runtime reads/writes in this repository. Safe to run after prior cleanup
-- migrations or on a partially migrated database.

ALTER TABLE IF EXISTS public.licenses
  DROP COLUMN IF EXISTS tokens_remaining;

DROP TABLE IF EXISTS public.credits CASCADE;
DROP TABLE IF EXISTS public.organization_members CASCADE;
DROP TABLE IF EXISTS public.users CASCADE;
DROP TABLE IF EXISTS public.password_reset_tokens CASCADE;
