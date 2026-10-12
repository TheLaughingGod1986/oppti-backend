-- Optional "How did you find us?" answer captured at plugin sign-up.
-- Kept separate from Loops first-touch source / signupPlugin (PR #31).
ALTER TABLE public.licenses
  ADD COLUMN IF NOT EXISTS signup_source text,
  ADD COLUMN IF NOT EXISTS signup_source_other text;

ALTER TABLE public.licenses
  DROP CONSTRAINT IF EXISTS licenses_signup_source_check;
ALTER TABLE public.licenses
  ADD CONSTRAINT licenses_signup_source_check
  CHECK (signup_source IS NULL OR signup_source IN (
    'wporg_search', 'google', 'ai_assistant', 'oppti_site', 'friend_colleague', 'social', 'other'
  ));

ALTER TABLE public.licenses
  DROP CONSTRAINT IF EXISTS licenses_signup_source_other_len;
ALTER TABLE public.licenses
  ADD CONSTRAINT licenses_signup_source_other_len
  CHECK (signup_source_other IS NULL OR char_length(signup_source_other) <= 200);

COMMENT ON COLUMN public.licenses.signup_source IS 'Self-reported "How did you find us?" answer from plugin sign-up (optional).';
COMMENT ON COLUMN public.licenses.signup_source_other IS 'Free text when signup_source = other (max 200 chars, tags stripped).';
