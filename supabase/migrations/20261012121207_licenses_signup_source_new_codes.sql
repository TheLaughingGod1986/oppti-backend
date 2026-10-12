-- "How did you find us?" now uses the shared codes
-- wporg, search, x, facebook_group, friend, other.
-- The CHECK still allows the 7 original codes so rows written by
-- Alt Text 4.6.138/4.6.139 stay valid. New writes are normalized to the new
-- codes in fresh-stack/lib/signupSource.js (OLD_TO_NEW).
ALTER TABLE public.licenses
  DROP CONSTRAINT IF EXISTS licenses_signup_source_check;
ALTER TABLE public.licenses
  ADD CONSTRAINT licenses_signup_source_check
  CHECK (signup_source IS NULL OR signup_source IN (
    'wporg', 'search', 'x', 'facebook_group', 'friend', 'other',
    'wporg_search', 'google', 'ai_assistant', 'oppti_site', 'friend_colleague', 'social'
  ));
