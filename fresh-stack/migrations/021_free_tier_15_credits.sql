-- Lower the Free plan monthly allowance from 50 to 15 credits.
--
-- The free monthly limit is governed by public.plans.monthly_included_credits
-- (read at quota time via services/siteQuota.js and the reserve RPC). Updating
-- the plan row governs new periods and new sites. Existing current-period free
-- rows are downgraded explicitly below — the reserve RPC's ON CONFLICT uses
-- GREATEST(existing, excluded) and would otherwise keep the old 50.

UPDATE public.plans
SET monthly_included_credits = 15
WHERE id = 'free';

-- Existing current-period free site_quotas rows carry monthly_included_credits
-- = 50 (free is the only plan with that value: others are 0/100/1000/10000).
-- Bring them to 15 and recompute remaining. Paid rows are untouched.
UPDATE public.site_quotas
SET monthly_included_credits = 15,
    remaining_credits = GREATEST(
      0,
      15 + COALESCE(purchased_credits_balance, 0) + COALESCE(bonus_credits_balance, 0) - COALESCE(used_credits, 0)
    ),
    updated_at = NOW()
WHERE quota_period_end > NOW()
  AND monthly_included_credits = 50;
