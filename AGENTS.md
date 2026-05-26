# AGENTS.md

## Repo Scope

- Main entrypoint: `fresh-stack/server.js`
- Test root: `fresh-stack/tests`
- Deploy config: `render.yaml`

## Common Commands

```bash
npm install
npm start
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

## Smoke Test

```bash
BASE_URL=http://localhost:4000 SITE_KEY=test-site npm run smoke
```

Notes:
- The smoke script checks `/health`, `/ready`, `/billing/plans`, `/api/usage`, and `/api/alt-text`.
- Defaults are `BASE_URL=http://localhost:4000` and `SITE_KEY=test-site`.

## TODO

- If the team has a standard command for applying SQL files in `scripts/sql/` or `fresh-stack/migrations/`, add it here once it is documented in-repo.
