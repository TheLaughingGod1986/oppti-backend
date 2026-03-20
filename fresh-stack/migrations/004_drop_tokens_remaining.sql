-- Migration 004: Drop orphaned tokens_remaining column from licenses
-- This column was never read by any quota logic (quota is computed from usage_logs).
-- Safe to drop: no backend code reads it, and the plugin derives remaining credits
-- from the API response which uses usage_logs + quota_summaries.

ALTER TABLE licenses DROP COLUMN IF EXISTS tokens_remaining;
