-- Guest-to-account conversion markers (Titles 1.0.33 guest first result),
-- website_auditor as a signup plugin, and signup_plugin_source for backfilled rows.
-- Additive and idempotent. Written best-effort by the register route
-- (fresh-stack/services/guestSignup.js), so sign-up works before this runs.
ALTER TABLE public.licenses
  ADD COLUMN IF NOT EXISTS signup_entry text,
  ADD COLUMN IF NOT EXISTS converted_from_guest boolean NOT NULL DEFAULT false;

ALTER TABLE public.licenses
  DROP CONSTRAINT IF EXISTS licenses_signup_entry_check;
ALTER TABLE public.licenses
  ADD CONSTRAINT licenses_signup_entry_check
  CHECK (signup_entry IS NULL OR signup_entry IN ('guest_trial'));

COMMENT ON COLUMN public.licenses.signup_entry IS 'Where in the plugin the account was created (guest_trial = the guest flow Create account click). Separate from signup_source.';
COMMENT ON COLUMN public.licenses.converted_from_guest IS 'True when the registering site had guest-trial usage before the account existed.';

-- Accept Website Auditor as a first-touch signup plugin (register allow-list).
ALTER TABLE public.licenses
  DROP CONSTRAINT IF EXISTS licenses_signup_plugin_check;
ALTER TABLE public.licenses
  ADD CONSTRAINT licenses_signup_plugin_check
  CHECK (signup_plugin IS NULL OR signup_plugin IN ('alt_text', 'titles', 'internal_linking', 'content_refresh', 'website_auditor'));

-- Where a signup_plugin value came from. NULL = written by /auth/register
-- (first-touch). Set only by the one-off backfill script
-- (scripts/backfill-signup-plugin.js) on rows it fills.
ALTER TABLE public.licenses
  ADD COLUMN IF NOT EXISTS signup_plugin_source text;
ALTER TABLE public.licenses
  DROP CONSTRAINT IF EXISTS licenses_signup_plugin_source_check;
ALTER TABLE public.licenses
  ADD CONSTRAINT licenses_signup_plugin_source_check
  CHECK (signup_plugin_source IS NULL OR signup_plugin_source IN (
    'inferred_auditor_referral',
    'inferred_first_usage',
    'inferred_stripe_checkout',
    'inferred_posthog',
    'inferred_first_connection'
  ));
