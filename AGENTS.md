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
npm run test:coverage
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

## Smoke Test

```bash
BASE_URL=http://localhost:4000 SITE_KEY=test-site npm run smoke
```

Notes:
- The smoke script checks `/health`, `/ready`, `/billing/plans`, `/api/usage`, and `/api/alt-text`.
- Defaults are `BASE_URL=http://localhost:4000` and `SITE_KEY=test-site`.

## TODO

- If the team has a standard command for applying SQL files in `scripts/sql/` or `fresh-stack/migrations/`, add it here once it is documented in-repo.
