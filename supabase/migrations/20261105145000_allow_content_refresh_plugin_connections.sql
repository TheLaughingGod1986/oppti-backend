-- Mirrors fresh-stack/migrations/029_allow_content_refresh_plugin_connections.sql.
-- Widens existing check constraints so Content Refresh can record plugin
-- connections and signup attribution. No new tables or columns.
ALTER TABLE public.account_plugin_connections
  DROP CONSTRAINT IF EXISTS account_plugin_connections_plugin_id_check;

ALTER TABLE public.account_plugin_connections
  ADD CONSTRAINT account_plugin_connections_plugin_id_check
  CHECK (plugin_id IN ('alt_text', 'titles', 'internal_linking', 'content_refresh'));

ALTER TABLE public.licenses
  DROP CONSTRAINT IF EXISTS licenses_signup_plugin_check;
ALTER TABLE public.licenses
  ADD CONSTRAINT licenses_signup_plugin_check
  CHECK (signup_plugin IS NULL OR signup_plugin IN ('alt_text', 'titles', 'internal_linking', 'content_refresh'));
