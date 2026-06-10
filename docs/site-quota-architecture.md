# Site Quota Architecture

## Canonical ownership model

The primary entitlement owner is `site`, not `user` and not `email`.

Core rules:

- one WordPress install resolves to one canonical `sites` row
- free monthly credits are attached to the site
- the one-time trial is attached to the site
- multiple human users can join the site through `site_memberships`
- paid subscriptions default to the site through `site_subscriptions`
- generation debit is recorded in an immutable site-owned ledger

## Entity model

### `licenses`

Human account table retained for compatibility.

| Column | Meaning |
|---|---|
| `id` | account/user id |
| `license_key` | legacy account auth key |
| `email` | human login identity |
| `plan` | legacy compatibility view of the effective plan |
| `stripe_customer_id` / `stripe_subscription_id` | compatibility pointers only |

### `sites`

Canonical WordPress install record.

| Column | Meaning |
|---|---|
| `id` | canonical site id |
| `site_hash` | legacy plugin site key |
| `wp_install_uuid` | stable install identifier |
| `normalized_site_url` | normalized URL for matching |
| `canonical_domain` | normalized host/domain |
| `site_fingerprint` | fingerprint-based matching |
| `owner_user_id` | optional primary owner |
| `license_key` | compatibility pointer only |
| `status` | `active`, `deactivated`, `merged`, `suspended` |
| `merged_into_site_id` | merge target for duplicate records |

### `site_memberships`

Many-to-many user access to sites.

| Column | Meaning |
|---|---|
| `site_id` | linked site |
| `user_id` | linked user/account |
| `role` | `owner`, `admin`, `member` |

Constraint:

- `unique(site_id, user_id)`

### `plans`

Canonical plan definitions.

| Column | Meaning |
|---|---|
| `id` | `free`, `pro`, `agency`, `credits` |
| `monthly_included_credits` | included recurring quota |
| `credit_grant_amount` | one-time credit grant if applicable |
| `billing_interval_default` | `month`, `year`, `one_time` |
| `is_paid` | pricing guardrails |

### `site_subscriptions`

Site-owned subscription / billing state.

| Column | Meaning |
|---|---|
| `site_id` | entitlement owner |
| `plan_id` | paid/free plan attached to site |
| `stripe_customer_id` | Stripe customer |
| `stripe_subscription_id` | Stripe subscription |
| `status` | `active`, `trialing`, `past_due`, `cancelled`, `incomplete` |
| `billing_interval` | `month`, `year`, `one_time` |
| `current_period_start` / `current_period_end` | active billing window |
| `cancel_at_period_end` | Stripe cancellation flag |

### `site_quotas`

Materialized quota snapshot per site billing window.

| Column | Meaning |
|---|---|
| `site_id` | entitlement owner |
| `quota_period_start` / `quota_period_end` | billing window |
| `monthly_included_credits` | recurring included quota |
| `purchased_credits_balance` | credit top-up balance |
| `bonus_credits_balance` | support/manual bonus balance |
| `used_credits` | total used in period |
| `remaining_credits` | convenience/materialized remaining credits |
| `reset_source` | `monthly_rollover`, `subscription_period`, etc. |

Constraint:

- `unique(site_id, quota_period_start, quota_period_end)`

### `site_trials`

Site-owned one-time trial.

| Column | Meaning |
|---|---|
| `site_id` | entitlement owner |
| `trial_type` | currently `initial` |
| `total_trial_credits` | default 3 unless configured |
| `used_trial_credits` | trial spend |
| `status` | `active`, `exhausted`, `cancelled` |
| `started_at` / `exhausted_at` | lifecycle timestamps |

Constraint:

- one active initial trial per site

### `generation_requests`

Atomic reservation state for debit/replay protection.

| Column | Meaning |
|---|---|
| `site_id` | entitlement owner |
| `user_id` | optional human actor |
| `status` | `reserved`, `consumed`, `released`, `failed` |
| `credits_reserved` / `credits_consumed` | debit amounts |
| `idempotency_key` | caller replay key |
| `request_fingerprint` | deterministic duplicate fingerprint |
| `metadata` | request context |

### `usage_events`

Immutable quota ledger / audit trail.

| Column | Meaning |
|---|---|
| `site_id` | entitlement owner |
| `user_id` | optional human actor |
| `generation_request_id` | linked generation request |
| `event_type` | `trial_consume`, `quota_consume`, `credit_purchase`, `refund`, `admin_adjustment`, etc. |
| `credits_delta` | signed ledger delta |
| `idempotency_key` | duplicate protection |
| `metadata` | billing/generation audit context |

### `site_audit_logs`

Operator trail for joins, duplicates, merges, suspicious attempts, grants, resets.

### `site_merges`

Historical record of duplicate site consolidation emitted by deprecated merge
tooling. Not used by runtime request paths.

## Relationship summary

| From | To | Type | Purpose |
|---|---|---|---|
| `licenses.id` | `site_memberships.user_id` | 1:N | user access to multiple sites |
| `sites.id` | `site_memberships.site_id` | 1:N | team memberships |
| `sites.id` | `site_subscriptions.site_id` | 1:N | billing ownership |
| `sites.id` | `site_quotas.site_id` | 1:N | quota windows |
| `sites.id` | `site_trials.site_id` | 1:N | trial lifecycle |
| `sites.id` | `generation_requests.site_id` | 1:N | request reservations |
| `sites.id` | `usage_events.site_id` | 1:N | immutable ledger |
| `generation_requests.id` | `usage_events.generation_request_id` | 1:N | request -> ledger audit |

## Canonical identity resolution

Matching order:

1. exact `wp_install_uuid`
2. exact `site_hash`
3. exact `site_fingerprint`
4. exact legacy `fingerprint`
5. exact `normalized_site_url`
6. single unambiguous `canonical_domain`
7. manual merge/review when ambiguous

The normalization rules are defined in `docs/site-identity-rules.md`.

## Quota lifecycle

### Trial

- one active initial trial per site
- trial spend debited atomically
- reinstall/reconnect resolves back to the same canonical site when signals match

### Free monthly plan

- 50 credits per site per month
- shared across all members of the site
- new email registration on the same site joins the existing site instead of minting a new site quota

### Paid plan

- subscription maps to site
- upgrade from any member session applies to the site
- Stripe customer/subscription ids reconcile back to `site_subscriptions`

### Credit consumption

1. reserve credits in `generation_requests`
2. perform generation
3. finalize success/failure
4. write immutable `usage_events`
5. keep legacy `usage_logs` for compatibility during rollout

## Anti-abuse controls

### Duplicate-site prevention

- canonical site resolution
- ambiguity logging in `site_audit_logs`
- merge function `bbai_merge_sites(...)`

### Rate limiting

- per IP on auth endpoints
- per site + IP on generation
- per user on generation
- thresholds configurable in env

### Idempotency

- generation request idempotency key + request fingerprint
- Stripe event dedupe via `$insert_id = stripe_event_id`

### Reinstall resilience

- install UUID, fingerprint, URL, and domain matching
- trial and free state owned by site, not by email

### Auditability

- `usage_events`
- `site_audit_logs`
- `site_merges`

## Backward compatibility

- legacy `licenses`, `usage_logs`, `quota_summaries`, and `subscriptions` remain intact
- `getQuotaStatus(...)` falls back to legacy license-centric logic if the new site quota tables/functions are not yet available
- anonymous trial also fail-opens to legacy behavior if migration 008 is absent

## Operator queries

### Duplicate sites

```sql
select canonical_domain, count(*) as site_count
from sites
where merged_into_site_id is null
group by canonical_domain
having count(*) > 1
order by site_count desc;
```

### Sites with multiple users

```sql
select site_id, count(*) as member_count
from site_memberships
group by site_id
having count(*) > 1
order by member_count desc;
```

### Sites consuming free quota this month

```sql
select sq.site_id, sq.used_credits, sq.remaining_credits
from site_quotas sq
join site_subscriptions ss on ss.site_id = sq.site_id
where ss.plan_id = 'free';
```

### Legacy user-linked subscriptions still unmigrated

```sql
select id, license_key, stripe_subscription_id, status
from subscriptions
where site_id is null
  and status in ('active', 'trialing', 'past_due');
```
