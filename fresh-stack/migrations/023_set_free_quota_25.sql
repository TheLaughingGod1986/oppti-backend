-- Raise the Free plan monthly AI allowance from 15 to 25 credits.
--
-- Source of truth: public.plans.monthly_included_credits (read by
-- services/siteQuota.js and the reserve RPC). Updating the plan row governs
-- new sites and new periods. Existing current-period free site_quotas rows are
-- raised explicitly so free sites get 25 immediately after deploy (preferred
-- over waiting for monthly reset). Paid plans are untouched.

UPDATE public.plans
   SET monthly_included_credits = 25,
       updated_at = NOW()
 WHERE id = 'free'
   AND monthly_included_credits <> 25;

-- Free is the only plan with monthly_included_credits = 15 (starter=100,
-- growth/pro=1000, agency=10000). Recompute remaining from used + balances.
UPDATE public.site_quotas
   SET monthly_included_credits = 25,
       remaining_credits = GREATEST(
         0,
         25 + COALESCE(purchased_credits_balance, 0) + COALESCE(bonus_credits_balance, 0) - COALESCE(used_credits, 0)
       ),
       updated_at = NOW()
 WHERE quota_period_end > NOW()
   AND monthly_included_credits = 15;

-- Legacy per-site quota mirror on public.sites (cancel/downgrade path).
UPDATE public.sites
   SET quota_limit = 25
 WHERE quota_limit = 15
   AND COALESCE(plan, 'free') = 'free';
