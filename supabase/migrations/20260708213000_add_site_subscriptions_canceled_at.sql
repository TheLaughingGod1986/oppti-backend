-- Production hotfix: billing webhook selects site_subscriptions.canceled_at
ALTER TABLE IF EXISTS public.site_subscriptions
  ADD COLUMN IF NOT EXISTS canceled_at TIMESTAMPTZ;
