-- Raise the Free plan monthly AI allowance from 15 to 25 credits.
-- Mirrors fresh-stack/migrations/023_set_free_quota_25.sql.
--
-- Existing current-period free site_quotas get 25 immediately after deploy.
-- Paid plans are untouched.

UPDATE public.plans
   SET monthly_included_credits = 25,
       updated_at = NOW()
 WHERE id = 'free'
   AND monthly_included_credits <> 25;

UPDATE public.site_quotas
   SET monthly_included_credits = 25,
       remaining_credits = GREATEST(
         0,
         25 + COALESCE(purchased_credits_balance, 0) + COALESCE(bonus_credits_balance, 0) - COALESCE(used_credits, 0)
       ),
       updated_at = NOW()
 WHERE quota_period_end > NOW()
   AND monthly_included_credits = 15;

UPDATE public.sites
   SET quota_limit = 25
 WHERE quota_limit = 15
   AND COALESCE(plan, 'free') = 'free';
