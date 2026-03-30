# Site Quota Rollout Plan

## Goal

Move BeepBeep AI from a partially user-centric quota model to a canonical site-owned entitlement model without breaking paid customers, trial traffic, or Stripe reconciliation.

## Deploy order

### 1. Backup and audit

- take the normal production Supabase backup/snapshot
- run `node scripts/audit-site-duplicates.js`
- review:
  - duplicate canonical domains
  - duplicate install UUIDs
  - sites with multiple distinct emails
  - legacy subscriptions without `site_id`

### 2. Apply additive schema migration

Apply:

- `fresh-stack/migrations/008_site_owned_quota_model.sql`

Why first:

- generation reservation/finalization uses new RPC functions when available
- auth/billing/site reconciliation become much stronger once the new tables exist

### 3. Backfill canonical site data

Dry run:

```bash
node scripts/backfill-sites.js
```

Apply:

```bash
node scripts/backfill-sites.js --write
```

### 4. Reconcile Stripe subscriptions to sites

Dry run:

```bash
node scripts/reconcile-stripe-subscriptions-to-sites.js
```

Apply:

```bash
node scripts/reconcile-stripe-subscriptions-to-sites.js --write
```

### 5. Migrate current quota/trial snapshots

Dry run:

```bash
node scripts/migrate-user-quotas-to-site-quotas.js
```

Apply:

```bash
node scripts/migrate-user-quotas-to-site-quotas.js --write
```

### 6. Deploy backend code

Deploy the updated backend with:

- site identity normalization
- site-owned quota reads/writes
- rate limiting
- site-owned Stripe reconciliation

Backward compatibility:

- `getQuotaStatus(...)` still falls back to legacy state if new tables are unavailable
- anonymous trial now also fail-opens to legacy behavior if site quota v2 tables/functions are not yet live

### 7. Deploy plugin contract updates

Ensure the plugin sends:

- `install_uuid`
- `site_hash`
- `site_url`
- `site_fingerprint`
- idempotency key on generation retries

## Rollback notes

### Code rollback

- backend code can roll back independently because migration 008 is additive
- legacy `licenses`, `usage_logs`, `quota_summaries`, and `subscriptions` remain present

### Data rollback

- do not drop new tables during initial rollout
- if site-owned quota logic misbehaves, point runtime back at legacy quota reads while preserving the newly collected audit data

### What not to roll back destructively

- do not delete `site_memberships`, `site_subscriptions`, `site_quotas`, `site_trials`, `usage_events`, or `site_audit_logs` during the first rollout window
- they are additive and useful for diagnosis even if traffic temporarily falls back to legacy behavior

## Monitoring steps

### Backend

Watch logs for:

- `DEVELOPMENT_SITE_NOT_ALLOWED`
- `AMBIGUOUS_SITE_MATCH`
- `[siteQuota] reserve rpc failed`
- `[billing] site entitlement reconciliation failed`
- unexpected growth in `legacy_reserved` / `legacy_trial` fallback paths

### Database

Watch:

- growth of `generation_requests`
- growth of `usage_events`
- active `site_trials`
- active `site_subscriptions`
- duplicate-site audit output after backfill

### Billing

Verify:

- webhook deliveries still return `200`
- `payment_succeeded` analytics remain deduped
- active subscriptions reconcile to `site_subscriptions`

## Post-deploy checks

### Same site, two emails

- register/login two different human users on the same site
- confirm both are members of one `sites.id`
- confirm quota usage is shared

### Reinstall

- reconnect the same site with the same install UUID / site hash
- confirm it resolves to the same site
- confirm trial is not reset

### Billing

- create Stripe checkout for a known site
- confirm metadata includes site/account identifiers
- confirm webhook reconciles to `site_subscriptions`

## Feature flags / rollout switches

The implementation already supports these operational controls:

- `ALLOW_DEV_SITE_QUOTA=true`
  - allow localhost/dev sites to claim quota in non-standard environments
- `AUTH_RATE_LIMIT_PER_IP`
- `RATE_LIMIT_PER_SITE_IP`
- `RATE_LIMIT_PER_USER`
- `SKIP_QUOTA_CHECK_SITE_IDS`
  - emergency bypass for explicitly listed site ids only

No destructive feature flag is required because the rollout is additive and legacy fallbacks remain in place.

## Admin visibility queries

### How many duplicate sites exist?

Use:

```bash
node scripts/audit-site-duplicates.js
```

### How many sites have more than one user?

```sql
select count(*) from (
  select site_id
  from site_memberships
  group by site_id
  having count(*) > 1
) x;
```

### How many sites consumed free quota this month?

```sql
select count(*)
from site_quotas sq
left join site_subscriptions ss on ss.site_id = sq.site_id
where coalesce(ss.plan_id, 'free') = 'free'
  and sq.used_credits > 0;
```

### How many suspicious multi-email attempts occurred?

```sql
select count(*)
from site_audit_logs
where event_type in ('ambiguous_site_match', 'register_joined_existing_site', 'login_joined_existing_site');
```

### How many legacy user-linked subscriptions remain unmigrated?

```sql
select count(*)
from subscriptions
where site_id is null
  and status in ('active', 'trialing', 'past_due');
```
