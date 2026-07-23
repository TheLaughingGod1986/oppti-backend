-- Align the Free plan monthly allowance to 15 (it was seeded at 50).
-- The plugin enforces 15 free AI generations/month, and every public pricing
-- surface (WordPress.org listing + oppti.dev) advertises 15. This corrects the
-- plan definition and any free sites still holding the legacy 50 default.
-- Idempotent: safe to run whether the current value is already 15 or still 50.

-- 1) Plan definition (source of truth for the free tier).
UPDATE public.plans
   SET monthly_included_credits = 15,
       updated_at = NOW()
 WHERE id = 'free'
   AND monthly_included_credits <> 15;

-- 2) Legacy per-site quota rows still on the old 50 default.
--    Only touches free sites currently at exactly 50 — leaves paid sites and
--    any manually-adjusted quotas untouched. Review against your live quota
--    model (public.sites vs public.site_quotas) before applying to production.
UPDATE public.sites
   SET quota_limit = 15
 WHERE quota_limit = 50
   AND COALESCE(plan, 'free') = 'free';
