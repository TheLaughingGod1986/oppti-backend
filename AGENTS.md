# AGENTS.md

## Repo Scope

- Main entrypoint: `fresh-stack/server.js`
- Test root: `fresh-stack/tests`
- Deploy config: `render.yaml`

## Common Commands

```bash
npm install
npm start
npm run start:fresh
npm run dev
npm test
npm run test:unit
npm run test:integration
npm run test:watch
npm run test:coverage
npm run test:ci
npm run smoke
```

Notes:
- `npm start` and `npm run dev` both run `fresh-stack/server.js`.
- `npm run start:fresh` is an explicit alias for `node fresh-stack/server.js`.
- Jest is configured in `jest.config.js` to read tests from `fresh-stack/tests`, so the package scripts remain valid even though they do not include that path explicitly.

## Operator Workflows

Data integrity diagnostics:

```bash
npm run diagnostics:data-integrity -- --pretty
npm run diagnostics:data-integrity -- --pretty --days 30
```

Notes:
- Requires backend env vars, especially `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`.
- The script prints the same diagnostics payload used by `GET /admin/diagnostics/data-integrity`.

Image alt-state ledger sync:

```bash
cat inventory.json | npm run ledger:sync -- --site-hash <hash> --pretty
npm run ledger:sync -- --site-id <uuid> --input inventory.json --pretty
```

Notes:
- Target selection is required: use one of `--site-id`, `--site-hash`, `--license-key`, `--site-url`, `--install-uuid`, or `--site-fingerprint`.
- `--scope` accepts `full_site` or `partial`.
- Existing approved/review states are preserved unless `--allow-downgrade` is set.

Site quota V2 verification:

```bash
npm run verify:site-quota-v2
```

Notes:
- This script shells out to the `supabase` CLI and checks the linked project schema.

Site-owned quota V2 SQL restore:

```bash
# read-only preflight
scripts/sql/restore_site_owned_quota_v2_preflight.sql

# linked-project replay of the production-safe restore
supabase/migrations/20260421143000_reconcile_site_owned_quota_v2_schema.sql

# optional data backfill after the restore
scripts/sql/restore_site_owned_quota_v2_backfill.sql

# post-deploy verification
scripts/sql/restore_site_owned_quota_v2_post_deploy_verification.sql
```

Notes:
- This is a manual SQL workflow; no standard repo command for applying these files is documented yet.
- The linked-project migration notes that production execution should avoid wrapping the whole file in one explicit transaction because some indexes are built `CONCURRENTLY`.
- Run the preflight and post-deploy verification SQL around the restore, and only apply the backfill when the schema repair is complete.

Legacy object cleanup fallback:

```bash
# preferred path
fresh-stack/migrations/007_drop_confirmed_unused_legacy_objects.sql

# manual fallback for Supabase SQL Editor
scripts/cleanup-redundant-tables.sql
```

Notes:
- Prefer the migration file; the fallback SQL exists only for manual cleanup when the migration path is not available.
- The fallback drops the legacy `licenses.tokens_remaining` column plus redundant `credits`, `organization_members`, `password_reset_tokens`, and `users` tables.

Site quota rollout backfill:

```bash
node scripts/backfill-sites.js
node scripts/backfill-sites.js --write
```

Notes:
- Loads `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` from repo-root `.env`.
- Dry-run is the default; add `--write` to backfill canonical site fields, missing memberships, and trial-derived `sites` rows.

Stripe subscription reconciliation:

```bash
node scripts/reconcile-stripe-subscriptions-to-sites.js
node scripts/reconcile-stripe-subscriptions-to-sites.js --write
```

Notes:
- Loads `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` from repo-root `.env`.
- Dry-run is the default; add `--write` to upsert `site_subscriptions` and attach legacy `subscriptions.site_id` values.

Stripe entitlement repair:

```bash
npm run repair:stripe-entitlement -- --subscription-id <sub_id> --license-key <license_key>
npm run repair:stripe-entitlement -- --subscription-id <sub_id> --license-key <license_key> --site-id <site_id> --write
```

Notes:
- Requires `STRIPE_SECRET_KEY`, `SUPABASE_URL`, and `SUPABASE_SERVICE_ROLE_KEY` from repo-root `.env`.
- `--subscription-id` and `--license-key` are required; `--site-id`, `--site-url`, and `--customer-id` are optional disambiguators.
- Dry-run is the default; add `--write` to upsert `site_subscriptions`, refresh license Stripe pointers, and seed the current `site_quotas` period when missing.

Loops contact attribution backfill:

```bash
npm run backfill:loops-contacts
npm run backfill:loops-contacts -- --email=user@example.com --write
npm run backfill:loops-contacts -- --limit=25
```

Notes:
- Requires `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`; `--write` also requires `LOOPS_API_KEY` and `LOOPS_PLUGIN_USERS_LIST_ID`.
- Dry-run is the default. Membership is inferred from successful `usage_logs.feature_type` rows, with legacy accounts defaulting to `alt_text` when no usage exists.
- Optional filters: `--email=user@example.com` narrows to one active license, and `--limit=25` caps the number of processed accounts.

Legacy quota migration:

```bash
node scripts/migrate-user-quotas-to-site-quotas.js
node scripts/migrate-user-quotas-to-site-quotas.js --write
```

Notes:
- Loads `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` from repo-root `.env`.
- Dry-run is the default; add `--write` to populate `site_quotas` and `site_trials` from current legacy usage and subscription state.

Duplicate-site audit:

```bash
node scripts/audit-site-duplicates.js
node scripts/audit-site-duplicates.js --json
```

Notes:
- Loads `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` from repo-root `.env`.
- Audits unmerged `sites` records for duplicate install UUIDs, site hashes, fingerprints, domains, and multi-user memberships.

Manual site merge:

```bash
node scripts/merge-sites.js --source <site-id> --target <site-id>
node scripts/merge-sites.js --source <site-id> --target <site-id> --actor <user-id> --write
```

Notes:
- Default mode is dry-run; add `--write` to invoke `bbai_merge_sites`.
- This is operator-only and intended for manual duplicate-site resolution.

License password reset:

```bash
node scripts/reset-license-password.js <email> <newPassword>
LICENSE_EMAIL=user@example.com NEW_PASSWORD='new-password' node scripts/reset-license-password.js
```

Notes:
- Loads `.env` and `.env.local`.
- Uses `DATABASE_URL` when present, otherwise falls back to `SUPABASE_URL` plus `SUPABASE_SERVICE_ROLE_KEY`.

## Local Setup Helpers

Supabase connection check:

```bash
node scripts/test-supabase.js
```

Notes:
- Loads `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` from `.env.local`.
- This is a connectivity check for local credentials; a missing test table still counts as a successful connection.

Test license setup:

```bash
node scripts/setup-test-license.js
```

Notes:
- Loads `.env.local` and uses `db/supabase-client.js`.
- Ensures the `licenses` table is reachable, then creates or reuses the fixed development license key `24c93235-1053-4922-b337-9866aeb76dcc`.

Legacy quota reset:

```bash
node scripts/reset-quota.js <license-key>
node scripts/reset-quota.js --all
node scripts/reset-quota.js <license-key> --clear-logs
```

Notes:
- Loads `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` from `.env.local`.
- Intended for local testing against legacy `quota_summaries`; `--all` clears the current period for every license.
- `--clear-logs` also deletes matching `usage_logs` rows from the last 24 hours.

## Smoke Test

```bash
BASE_URL=http://localhost:4000 SITE_KEY=test-site npm run smoke
```

Notes:
- The smoke script checks `/health`, `/ready`, `/billing/plans`, `/api/usage`, and `/api/alt-text`.
- Defaults are `BASE_URL=http://localhost:4000` and `SITE_KEY=test-site`.

## TODO

- If the team has a standard command for applying SQL files in `scripts/sql/` or `fresh-stack/migrations/`, add it here once it is documented in-repo.
