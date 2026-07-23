-- Align the Free plan monthly allowance to 15 (it was seeded at 50).
-- Mirrors supabase/migrations/20260723120000_set_free_quota_15.sql.
-- The plugin enforces 15 free AI generations/month, and every public pricing
-- surface (WordPress.org listing + oppti.dev) advertises 15. Idempotent.

-- 1) Plan definition (source of truth for the free tier).
UPDATE public.plans
   SET monthly_included_credits = 15,
       updated_at = NOW()
 WHERE id = 'free'
   AND monthly_included_credits <> 15;

-- 2) Legacy per-site quota rows still on the old 50 default (free sites only).
UPDATE public.sites
   SET quota_limit = 15
 WHERE quota_limit = 50
   AND COALESCE(plan, 'free') = 'free';
