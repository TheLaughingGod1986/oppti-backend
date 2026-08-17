-- Raise anonymous/guest trial from 5 to 10 credits.
--
-- Runtime Node default is getAnonymousTrialLimit() (ANONYMOUS_TRIAL_CREDITS /
-- SITE_TRIAL_CREDITS / TRIAL_LIMIT, else 10) and is passed as p_trial_credits
-- for new rows. Align DB defaults and existing initial trials still on 5.

ALTER TABLE IF EXISTS public.site_trials
  ALTER COLUMN total_trial_credits SET DEFAULT 10;

UPDATE public.site_trials
   SET total_trial_credits = 10,
       updated_at = NOW()
 WHERE trial_type = 'initial'
   AND total_trial_credits = 5;
