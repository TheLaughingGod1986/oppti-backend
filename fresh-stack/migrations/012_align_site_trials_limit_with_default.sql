-- Align legacy site_trials rows that still use the old default (3) with the
-- current product default (5). Node passes p_trial_credits from
-- ANONYMOUS_TRIAL_CREDITS / getAnonymousTrialLimit() for new rows; existing
-- rows with total_trial_credits = 3 caused dashboard (mixed sources) vs RPC (3)
-- inconsistencies.
UPDATE public.site_trials
SET
  total_trial_credits = 5,
  updated_at = NOW()
WHERE trial_type = 'initial'
  AND total_trial_credits = 3;
