# Database Audit – Table Usage & Optimization

**Date:** March 4, 2026  
**Scope:** oppti-backend, WP-Alt-text-plugin (BeepBeep AI)

---

## Tables Required by Backend (oppti-backend)

| Table | Used By | Purpose |
|-------|---------|---------|
| `licenses` | auth, quota, usage, billing, license, site, dashboard | Core auth, plan, billing |
| `sites` | auth, quota, site, license, server, usage | Activated sites per license |
| `usage_logs` | usage, quota, reset-quota | Per-generation usage tracking |
| `quota_summaries` | usage, quota, reset-quota | Pre-aggregated quota lookups |
| `credits` | billing | One-time credit purchases |
| `subscriptions` | billing | Stripe subscription sync |
| `trial_usage` | altText | Anonymous trial generations |
| `dashboard_sessions` | dashboard | Dashboard web app sessions |
| `debug_logs` | dashboard | Error/debug logs for troubleshooting |

---

## Tables Required by Frontend (WP Plugin)

The WP plugin does **not** query Supabase directly. It calls the backend API. Usage/events in the plugin come from:

- **Local WP tables:** `bbai_usage_logs`, `bbai_credit_usage`, etc. (WordPress DB)
- **Backend API:** Usage, quota, license data come from oppti-backend → Supabase

---

## Redundant Tables (Removed)

| Table | Rows | Reason |
|-------|------|--------|
| `identities` | 0 | No code references. Legacy/planned identity system, never used. |
| `events` | 0 | Comment: "Unified event system - replaces analytics_events and credits_transactions". No code references in backend or frontend. |
| `plugin_identities` | 0 | No code references. Unused. |

**Action taken:** Dropped `events`, `plugin_identities`, `identities` (in that order due to FK: events → identities).

---

## Current Schema (Post-Cleanup)

- licenses
- sites
- usage_logs
- quota_summaries
- credits
- subscriptions
- trial_usage
- dashboard_sessions
- debug_logs

---

## Optimization Notes

1. **Indexes:** Existing indexes on `license_key`, `site_hash`, `created_at` are appropriate for current queries.
2. **usage_logs:** Consider partitioning by `created_at` if volume grows (see DATABASE_SCHEMA.md).
3. **Cleanup jobs:** Ensure scheduled jobs run for `dashboard_sessions` (expired) and `debug_logs` (>90 days).
