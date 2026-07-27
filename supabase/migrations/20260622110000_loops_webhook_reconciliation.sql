ALTER TABLE licenses
  ADD COLUMN IF NOT EXISTS loops_contact_id TEXT,
  ADD COLUMN IF NOT EXISTS marketing_email_status TEXT,
  ADD COLUMN IF NOT EXISTS loops_last_event_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS loops_webhook_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  webhook_id TEXT NOT NULL UNIQUE,
  event_name TEXT NOT NULL,
  event_time TIMESTAMPTZ,
  contact_id TEXT,
  contact_user_id TEXT,
  contact_email TEXT,
  payload JSONB NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_loops_webhook_events_contact_user_id
  ON loops_webhook_events(contact_user_id);
CREATE INDEX IF NOT EXISTS idx_loops_webhook_events_event_time
  ON loops_webhook_events(event_time DESC);

ALTER TABLE loops_webhook_events ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS account_plugin_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  license_id UUID NOT NULL REFERENCES licenses(id) ON DELETE CASCADE,
  plugin_id TEXT NOT NULL CHECK (plugin_id IN ('alt_text', 'titles')),
  plugin_version TEXT,
  first_connected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_connected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (license_id, plugin_id)
);

CREATE INDEX IF NOT EXISTS idx_account_plugin_connections_plugin_id
  ON account_plugin_connections(plugin_id);

ALTER TABLE account_plugin_connections ENABLE ROW LEVEL SECURITY;
