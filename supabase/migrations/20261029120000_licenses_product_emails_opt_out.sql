-- Optional "Don't send me product tips and plan emails" choice made at sign-up.
-- NULL = not asked (account created before the checkbox existed, or by an
-- older plugin). TRUE = opted out: the backend sets subscribed=false on the
-- Loops contact and sends no product lifecycle events for the account.
ALTER TABLE public.licenses
  ADD COLUMN IF NOT EXISTS product_emails_opt_out boolean;

COMMENT ON COLUMN public.licenses.product_emails_opt_out IS 'Sign-up choice: true = no product tips or plan emails (Loops subscribed=false, no product events). NULL = not asked.';
