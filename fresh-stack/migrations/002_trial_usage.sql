-- Trial usage tracking table.
-- Tracks anonymous site trial generations (up to 10 per site hash).
-- No foreign key to licenses since trial users don't have accounts yet.
CREATE TABLE IF NOT EXISTS trial_usage (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  site_hash VARCHAR(255) NOT NULL,
  site_fingerprint VARCHAR(255),
  site_url VARCHAR(500),
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  total_tokens INTEGER,
  model_used VARCHAR(100),
  generation_time_ms INTEGER,
  image_filename VARCHAR(500),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_trial_usage_site_hash ON trial_usage(site_hash);
CREATE INDEX IF NOT EXISTS idx_trial_usage_created_at ON trial_usage(created_at);
