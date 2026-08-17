-- Raise anonymous/guest trial from 5 to 10 credits.
-- Mirrors fresh-stack/migrations/024_set_guest_trial_10.sql.

ALTER TABLE IF EXISTS public.site_trials
  ALTER COLUMN total_trial_credits SET DEFAULT 10;

UPDATE public.site_trials
   SET total_trial_credits = 10,
       updated_at = NOW()
 WHERE trial_type = 'initial'
   AND total_trial_credits = 5;
