# Site Quota Audit

## Executive summary

The pre-existing BeepBeep AI backend is only partially site-centric. The plugin has long sent strong site signals (`site_url`, `site_hash`, `site_fingerprint`), and several code paths already try to share quota by `site_hash`, but the canonical data model still centers entitlements on `licenses` (human accounts). That leaves multiple abuse openings:

- a second email can create a second `licenses` row for the same WordPress site
- the trial path is detached from paid/free quota state and can drift from backend truth
- legacy quota reads aggregate by `license_key` unless a site hint is present
- Stripe subscriptions are stored on `licenses` / legacy `subscriptions`, not on a site-owned entitlement record
- generation debit was check-then-write, so concurrent requests and replayed requests could overrun quota

This change set introduces an additive site-owned quota model in `008_site_owned_quota_model.sql`, new site identity normalization, atomic reservation/finalization functions, site memberships, site-owned subscriptions, site-owned quota snapshots, and site audit logs. Legacy tables remain in place for compatibility and reporting while the new model is rolled out.

## Current schema inventory

### Legacy/live tables

| Entity | PK | Important unique constraints | Key columns | Current ownership model | Audit notes |
|---|---|---|---|---|---|
| `licenses` | `id` UUID | `license_key`, `email` | `license_key`, `email`, `plan`, `status`, `billing_cycle`, `billing_day_of_month`, `stripe_customer_id`, `stripe_subscription_id`, password-reset fields | User/email-centric | Still the runtime account table. Historically doubles as human account, billing record, and quota owner. This is the main source of free-credit abuse when site signals are ignored. |
| `sites` | `id` UUID | `site_hash` | `license_key`, `site_hash`, `site_url`, `fingerprint`, `plan`, `status`, `activated_at`, `last_activity_at` | Mixed: site record exists, but points back to `license_key` | Important but subordinate to `licenses`. Before this change it lacked canonical URL/domain/install UUID columns and did not prevent multiple users from receiving separate entitlements for the same site. |
| `usage_logs` | `id` UUID | none | `license_key`, `site_hash`, `credits_used`, `user_email`, `created_at` | Mostly user/license-centric with optional site tagging | Legacy quota ledger. Before migration 008 it lacked several runtime-expected columns (`license_id`, `plugin_version`, `endpoint`, `status`, `error_message`). Aggregation by `license_key` can overgrant if the wrong license is used for the same site. |
| `quota_summaries` | composite business key, no UUID | effectively `(license_key, period_start)` | `license_key`, `period_start`, `period_end`, `total_credits_used`, `site_usage` | License-centric | Pre-aggregated monthly quota usage. Helpful for legacy reads, but cannot be the final anti-abuse source of truth because it is keyed to `license_key`, not `site_id`. |
| `trial_usage` | `id` UUID | none | `site_hash`, `site_fingerprint`, `site_url`, model/token fields | Site-centric but isolated | Anonymous trial tracking is already site-based, but it is disconnected from subscriptions, memberships, and quota snapshots. Reinstall and site normalization drift can still create duplicate rows. |
| `subscriptions` | created ad hoc in runtime/docs, not consistently in older migrations | `stripe_subscription_id` | `license_key`, `site_id`, `plan`, `status`, `stripe_customer_id`, `stripe_subscription_id`, period fields | Legacy user-centric, partially site-linked | Runtime expects this table, but early schema did not create it reliably. Existing production rows may still be license-linked only. |

### Runtime state that is not table-backed

| Concern | Current implementation | Audit notes |
|---|---|---|
| API auth | JWT via `/auth`, license-key auth, trial headers | JWT and license-key flows both land on `licenses`. Trial auth is independent and historically not reconciled back into canonical site state. |
| Password reset | columns on `licenses` (`password_reset_token`, `password_reset_expires`) | Runtime expects columns that were not present in initial schema. Migration 008 adds them. |
| Rate limiting | in-memory Redis/local middleware | Previously keyed mostly by license or route. It did not enforce per-site + per-IP throttling on generation. |
| Checkout attribution | Stripe metadata + request headers | Before this change, metadata did not consistently carry site/account context, especially when static Payment Links were used. |

### New additive entities introduced in migration 008

| Entity | PK | Important uniqueness | Purpose |
|---|---|---|---|
| `plans` | `id` | `id` | Canonical plan definitions (`free`, `pro`, `agency`, `credits`) |
| `site_memberships` | `id` | `unique(site_id, user_id)` | Many-to-many site access. Enables team UX without per-user free quota. |
| `site_subscriptions` | `id` | `stripe_subscription_id` unique | Site-owned subscription record. Reconciles Stripe entitlements to a site. |
| `site_quotas` | `id` | `unique(site_id, quota_period_start, quota_period_end)` | Site-owned quota snapshot per billing window. |
| `site_trials` | `id` | partial unique active initial trial per site | One-time site-owned trial state. |
| `generation_requests` | `id` | `idempotency_key`, `request_fingerprint` | Atomic reservation/finalization state for generation debit. |
| `usage_events` | `id` | `idempotency_key` | Immutable site-owned quota ledger and audit trail. |
| `site_audit_logs` | `id` | none | Operational trail for joins, merges, suspicious matches, grants, resets. |
| `site_merges` | `id` | none | Records admin-driven site merges. |

## Current business logic flows and abuse findings

### Anonymous trial

Current code paths:

- plugin keeps local trial counter in `bbai_trial_usage_{site_hash}`
- backend accepts `X-Trial-Mode` + `X-Trial-Site-Hash`
- backend writes `trial_usage`
- `findOrCreateTrialSite(...)` now resolves a canonical site row for trial traffic

Abuse previously possible:

- reinstalling or changing formatting of the same URL could generate a fresh `site_hash`
- local-only trial state could drift from backend truth
- concurrent trial requests were not atomic

Current mitigation after this change:

- canonical site identity normalization in `fresh-stack/lib/siteIdentity.js`
- `site_trials` and `generation_requests` support one active trial per site
- reservation RPC enables atomic trial debit once migration 008 is live
- anonymous trial falls back safely to legacy behavior when v2 tables are absent so rollout is non-breaking

### Signup / login / connect site

Current code paths:

- `/auth/register` and `/auth/login` build canonical site identity from request body
- `attachSiteContextForAccount(...)` resolves or creates the canonical `sites` row
- `site_memberships` links additional users to the same site
- `syncLegacySitePointers(...)` keeps `sites.license_key` and legacy account billing pointers in sync

Historical abuse:

- same WordPress site could create multiple `licenses` rows with different emails
- entitlements attached to `licenses`, not to a shared site
- weak matching across URL variants and reinstalls

Current mitigation after this change:

- canonical site resolution order: install UUID -> `site_hash` -> fingerprint -> normalized URL -> canonical domain
- ambiguous canonical-domain matches are logged and blocked for manual review
- additional users may join the same site without minting a second site quota

### Generation request / quota check / debit

Current code paths:

- `POST /api/alt-text` builds site identity from headers
- `reserveGenerationQuota(...)` attempts atomic debit through `bbai_reserve_site_generation`
- `finalizeGenerationQuotaReservation(...)` finalizes success/failure
- legacy `usage_logs` and `trial_usage` are still written for compatibility/reporting

Historical abuse / correctness gaps:

- non-atomic check-then-write debit
- concurrent requests could overspend
- replayed generation requests could double spend
- quota reads depended on caller `license_key` in some paths

Current mitigation after this change:

- new atomic reservation/finalization RPC path
- idempotency key and request fingerprint stored in `generation_requests`
- per-site and per-user rate limiting on generation endpoints
- quota reads prefer canonical site-owned state, then fall back to legacy

### Paid upgrade / Stripe webhook reconciliation

Current code paths:

- `/billing/checkout` resolves canonical site and embeds `account_id`, `license_key`, `site_id`, `site_hash`, `user_id`, `email`, `plan`, `source=app` into Stripe metadata
- webhook resolves identity and site from metadata, Stripe ids, and legacy account records
- webhook reconciles site-owned entitlements through `site_subscriptions` / `site_quotas`

Historical abuse / correctness gaps:

- subscriptions lived on users, not sites
- metadata was inconsistent, especially through static Payment Links
- webhook replays had analytics dedupe but entitlement reconciliation was weaker

Current mitigation after this change:

- site-owned reconciliation via `reconcileBillingEntitlement(...)`
- Stripe ids persisted back onto legacy account only when mapping is confirmed
- payment analytics remain non-blocking and deduped with `$insert_id = stripe_event_id`

## Explicit failure modes found during audit

### 1. Same site could receive multiple free allocations across multiple emails

Cause:

- entitlements were keyed to `licenses.plan` and `quota_summaries.license_key`
- site linkage existed, but was not the canonical quota owner

Fix:

- `site_quotas`, `site_trials`, `site_subscriptions`, `site_memberships`
- canonical site resolution in auth, usage, billing, and generation routes

### 2. Reinstall / reconnect could create duplicate site rows

Cause:

- exact `site_hash` matching only
- no canonical URL/domain/install UUID normalization

Fix:

- `fresh-stack/lib/siteIdentity.js`
- `wp_install_uuid`, `normalized_site_url`, `canonical_domain`, `site_fingerprint`
- `bbai_merge_sites(...)` admin-safe merge function

### 3. Domain formatting noise could bypass quota sharing

Cause:

- `http` vs `https`, trailing slash, `www.`, default ports, and fingerprint drift were not normalized consistently

Fix:

- normalization rules documented in `docs/site-identity-rules.md`

### 4. Generation debit had race conditions

Cause:

- quota availability and usage logging were separate operations

Fix:

- `generation_requests`
- `usage_events`
- `bbai_reserve_site_generation(...)`
- `bbai_finalize_site_generation(...)`

### 5. Legacy schema drift could break runtime assumptions

Cause:

- runtime code expected columns/tables not guaranteed by initial migrations

Fix:

- migration 008 adds missing columns on `licenses` and `usage_logs`
- migration 008 creates legacy `subscriptions` table if absent before backfilling site-owned records

## Remaining risks after implementation

- static Stripe Payment Link fallback still weakens attribution if the plugin cannot create a backend Checkout Session
- older plugin versions that do not send install UUID / fingerprint will still depend on weaker matching heuristics
- migration 008 is additive and safe, but the duplicate-site backlog still needs operator review before aggressive merges
- `usage_logs` / `quota_summaries` remain for compatibility, so operators must avoid using them as the final entitlement source once site quota v2 is live

## Recommended operational metrics

Use the new scripts and tables to answer:

- duplicate sites: `node scripts/audit-site-duplicates.js`
- sites with >1 user: `site_memberships`
- suspicious multi-email attempts: `site_audit_logs` + `audit-site-duplicates.js`
- remaining legacy user-linked subscriptions: `subscriptions` rows with `site_id IS NULL`
- free quota consumption by site: `site_quotas`, `usage_events`
