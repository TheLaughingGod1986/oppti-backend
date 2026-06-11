-- Add the Starter subscription tier without changing existing Growth/Pro customers.
-- Stripe Product/Price must be created manually and exposed via
-- ALTTEXT_AI_STRIPE_PRICE_STARTER_MONTHLY or STRIPE_PRICE_STARTER_MONTHLY.

INSERT INTO public.plans (
  id,
  display_name,
  scope,
  monthly_included_credits,
  credit_grant_amount,
  billing_interval_default,
  is_paid,
  metadata
)
VALUES (
  'starter',
  'Starter',
  'site',
  100,
  0,
  'month',
  TRUE,
  jsonb_build_object(
    'plan_id', 'starter',
    'monthly_credits', 100,
    'site_limit', 1,
    'price', '4.99',
    'currency', 'gbp'
  )
)
ON CONFLICT (id) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  scope = EXCLUDED.scope,
  monthly_included_credits = EXCLUDED.monthly_included_credits,
  credit_grant_amount = EXCLUDED.credit_grant_amount,
  billing_interval_default = EXCLUDED.billing_interval_default,
  is_paid = EXCLUDED.is_paid,
  metadata = COALESCE(public.plans.metadata, '{}'::jsonb) || EXCLUDED.metadata,
  updated_at = NOW();
