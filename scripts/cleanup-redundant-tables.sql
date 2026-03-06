-- Cleanup redundant tables (oppti-backend no longer uses these)
-- Run in Supabase Dashboard > SQL Editor
-- Backup first if unsure.

DROP TABLE IF EXISTS public.organization_members CASCADE;
DROP TABLE IF EXISTS public.password_reset_tokens CASCADE;
DROP TABLE IF EXISTS public.users CASCADE;
