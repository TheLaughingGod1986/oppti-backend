-- Mirrors fresh-stack/migrations/027_allow_internal_linking_plugin_connections.sql.
ALTER TABLE public.account_plugin_connections
  DROP CONSTRAINT IF EXISTS account_plugin_connections_plugin_id_check;

ALTER TABLE public.account_plugin_connections
  ADD CONSTRAINT account_plugin_connections_plugin_id_check
  CHECK (plugin_id IN ('alt_text', 'titles', 'internal_linking'));

-- Sign-up attribution (Website Auditor + signup plugin). Folded into this
-- unapplied migration so PR #31 ships a single migration.
ALTER TABLE public.licenses
  ADD COLUMN IF NOT EXISTS signup_plugin text,
  ADD COLUMN IF NOT EXISTS auditor_finding text,
  ADD COLUMN IF NOT EXISTS signup_source_auditor boolean NOT NULL DEFAULT false;

ALTER TABLE public.licenses
  DROP CONSTRAINT IF EXISTS licenses_signup_plugin_check;
ALTER TABLE public.licenses
  ADD CONSTRAINT licenses_signup_plugin_check
  CHECK (signup_plugin IS NULL OR signup_plugin IN ('alt_text', 'titles', 'internal_linking'));

ALTER TABLE public.licenses
  DROP CONSTRAINT IF EXISTS licenses_auditor_finding_check;
ALTER TABLE public.licenses
  ADD CONSTRAINT licenses_auditor_finding_check
  -- Format only; the exact allow-list lives in fresh-stack/services/auditorAttribution.js.
  CHECK (auditor_finding IS NULL OR auditor_finding ~ '^[a-z0-9_]{1,64}$');
