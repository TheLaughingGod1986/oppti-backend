# Billing & Entitlement Architecture — Audit & Migration Plan

> Status: **audit / proposal** (no behaviour change). Authored as part of the
> 2026-06 billing hardening release. This documents the *current* dual-source
> entitlement model, the risk it creates, and a staged path to a single source
> of truth. Nothing here changes pricing, Stripe config, or checkout behaviour.

## TL;DR

Entitlement (what plan/credits a site has) is currently derived from **two
coexisting schema generations that are dual-written**:

- **Legacy, license-centric:** `licenses.plan`, `licenses.status`, `sites.plan`,
  `usage_logs`, `quota_summaries`.
- **Current, site-centric:** `site_subscriptions` (status + `plan_id`),
  `site_quotas`, `site_trials`, `plans`, `usage_events`.

The effective plan is resolved with the site-centric record **preferred** and
the legacy column as a **fallback** ([`services/siteQuota.js`](../fresh-stack/services/siteQuota.js) ~L1999):

```js
const hasPaidEntitlement = Boolean(subscription) || hasLegacyPaidEntitlementEvidence(legacyAccount);
const effectivePlanId   = subscription?.plan_id || (hasPaidEntitlement ? legacyAccount.plan : 'free');
```

Because the legacy column is still both **written** (many call sites) and
**read** as a fallback, the two can drift. That drift is what produced the
recent class of billing incidents (e.g. the checkout site-limit guard reading a
stale `licenses.plan`). The goal is to make **site-centric the single source of
truth** for entitlement decisions and demote `licenses` to auth/identity only.

---

## 1. Current Architecture

### 1.1 Entitlement sources (reads)

| Concern | Authoritative read | File(s) |
|---|---|---|
| Effective plan | `site_subscriptions.plan_id` → fallback `licenses.plan` | `services/siteQuota.js` (`effectivePlanId`) |
| Active subscription | `site_subscriptions` filtered to `ACTIVE_BILLING_STATUSES` | `routes/billing.js` (`selectBillingSiteSubscriptionForLicense`, `selectActiveSiteSubscription`) |
| Plan limits / credits | `plans` table → fallback `getLimits(plan)` | `services/siteQuota.js`, `services/quota.js` |
| Credits used / remaining | `site_quotas` (current), `usage_events` | `services/siteQuota.js` |
| Entitlement state (API response) | composed from the above | `services/entitlementState.js`, `services/dashboardStateTruth.js` |
| Trial | `site_trials` | `services/siteQuota.js` |

### 1.2 Legacy reads of `licenses` (plan/status) — to be migrated/retired

`licenses` is read in ~40 call sites. The entitlement-relevant ones (plan/status
decisions, not pure auth/identity lookups):

- `services/siteQuota.js` — `legacyAccount.plan` fallback in `effectivePlanId`; `hasLegacyPaidEntitlementEvidence`.
- `services/quota.js` — `getLimits(license.plan)`, `license.plan === 'agency'`, `plan_type: license.plan`.
- `routes/billing.js` — previously the checkout site-limit guard (now reads the active subscription instead, 2026-06).
- `routes/usage.js` (L304), `routes/dashboard.js` (L191), `services/usage.js`, `services/billing.js`, `services/bulkAltTextProcessor.js` — plan/limit reads.

Pure **auth/identity** reads of `licenses` (license_key → account, email,
stripe_customer_id) are **out of scope** — `licenses` legitimately stays the
identity record. This migration concerns only **plan/entitlement** reads.

### 1.3 Writes to legacy `licenses.plan`

- `services/siteQuota.js` (L2404, `licenseUpdates.plan = planId`) — dual-write on subscription change.
- Stripe webhook handlers in `routes/billing.js` (`buildCheckout/Invoice/SubscriptionStatusPayload`) propagate plan into both schemas.

These dual-writes are the drift source: any path that updates one schema but not
the other (or runs out of order) leaves `licenses.plan` stale.

---

## 2. Future Architecture (target)

**Single source of truth: the site-centric records.**

- **Entitlement** = `site_subscriptions` (status + `plan_id`) + `site_quotas` +
  `site_trials`, with `plans` as the static plan catalog.
- One resolver, `resolveEntitlement(siteId)`, returns
  `{ plan, status, credits_included, credits_used, credits_remaining, period_end, trial }`.
  **Every** plan/quota/checkout decision calls it. No caller reads `licenses.plan`.
- `licenses` is demoted to **identity/auth only**: `license_key`, `email`,
  `stripe_customer_id`, `stripe_subscription_id`. Its `plan`/`status` columns are
  frozen (kept for back-compat reads during transition, then dropped).
- `/billing/health` (added this release) is the public probe; `resolveEntitlement`
  is the internal one.

---

## 3. Migration Plan (staged, reversible)

**Stage 0 — Observability (this release).** `/billing/health`, billing analytics,
checkout telemetry, this audit. No behaviour change. Establishes a baseline.

**Stage 1 — Centralise reads.** Introduce `resolveEntitlement(siteId)` (wrap the
existing `siteQuota.js` logic). Route every plan/quota read through it. No write
changes yet. Add a metric/log whenever the legacy fallback (`licenses.plan`) is
actually used — this quantifies remaining drift exposure.

**Stage 2 — Make legacy read-only for entitlement.** Remove `licenses.plan` from
the `effectivePlanId` fallback; rely solely on `site_subscriptions`/`site_quotas`.
Backfill any sites missing a site-centric record first (one-off migration script,
verified against Stripe). Keep dual-writes on for rollback safety.

**Stage 3 — Stop dual-writing entitlement to legacy.** Webhooks/subscription
updates write only the site-centric schema. `licenses.plan`/`status` become inert.

**Stage 4 — Drop legacy entitlement columns.** After a bake period with the
Stage-1 fallback metric at zero, drop/retire `licenses.plan` and `sites.plan`.

Each stage is independently shippable and behind the prior stage's verification.

---

## 4. Rollback Plan

- **Stage 1:** pure addition — revert the PR; readers fall back to direct table reads.
- **Stage 2:** re-enable the `licenses.plan` fallback (one-line revert of the
  `effectivePlanId` change). Dual-writes are still on, so legacy data is current.
- **Stage 3:** re-enable legacy dual-writes (feature-flag the write path so
  rollback is a flag flip, not a deploy). Reconcile any sites changed during the
  gap with a replay of Stripe subscription webhooks.
- **Stage 4 (irreversible):** only after Stage 1's fallback-usage metric has been
  zero for the full bake period. Take a column backup (`pg_dump` of
  `licenses.plan`, `sites.plan`) before dropping.

Feature flags: gate Stage 2/3 behind `ENTITLEMENT_SINGLE_SOURCE` (read) and
`ENTITLEMENT_LEGACY_DUALWRITE` (write) env vars so behaviour can be toggled
without a deploy.

---

## 5. Risk Analysis

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| A paid site has no site-centric record → drops to `free` after Stage 2 | Medium | High (user loses access) | Backfill + verify against Stripe before Stage 2; Stage 1 fallback metric must reach 0 first |
| Webhook ordering leaves site-centric stale | Medium | Medium | Stage 1 resolver reads live subscription status; webhook replay tooling |
| Hidden `licenses.plan` reader missed in audit | Low | Medium | Stage 1 logs every legacy-fallback use; grep gate in CI for `licenses').select('plan'` |
| Trial vs paid edge cases | Low | Medium | `site_trials` already authoritative; covered by `resolveEntitlement` |
| Rollback after Stage 4 (columns dropped) | Low | High | Stage 4 gated on zero-fallback bake period + column backup |

---

## Appendix — how to regenerate this audit

```bash
# entitlement-relevant legacy reads
grep -rn "from('licenses')" fresh-stack --include='*.js' | grep -v '/tests/'
# site-centric reads
grep -rno "from('site_subscriptions')\|from('site_quotas')\|from('site_trials')\|from('plans')" fresh-stack --include='*.js'
# the effective-plan precedence
grep -n "effectivePlanId" fresh-stack/services/siteQuota.js
```
