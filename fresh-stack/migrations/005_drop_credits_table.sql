-- Migration 005: Drop legacy credits table
-- This table was from the old quota-tracking schema (columns: user_id, monthly_limit,
-- used_this_month, total_used, reset_date). The current system uses usage_logs +
-- quota_summaries instead. No backend code reads or writes to this table.
-- When credit pack purchases are built, a new table will be created at that time.

DROP TABLE IF EXISTS credits;
