ALTER TABLE public.account_plugin_connections
  DROP CONSTRAINT IF EXISTS account_plugin_connections_plugin_id_check;

ALTER TABLE public.account_plugin_connections
  ADD CONSTRAINT account_plugin_connections_plugin_id_check
  CHECK (plugin_id IN ('alt_text', 'titles', 'internal_linking'));
