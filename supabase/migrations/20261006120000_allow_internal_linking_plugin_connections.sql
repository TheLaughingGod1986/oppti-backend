-- Mirrors fresh-stack/migrations/025_allow_internal_linking_plugin_connections.sql.
ALTER TABLE public.account_plugin_connections
  DROP CONSTRAINT IF EXISTS account_plugin_connections_plugin_id_check;

ALTER TABLE public.account_plugin_connections
  ADD CONSTRAINT account_plugin_connections_plugin_id_check
  CHECK (plugin_id IN ('alt_text', 'titles', 'internal_linking'));
