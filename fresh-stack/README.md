# Fresh Alt-Text Stack

Lightweight backend + frontend built together for quick alt-text generation with guarded token usage.

## Run locally
```bash
npm start        # uses fresh-stack/server.js
# http://localhost:4000/health
```

## Required env
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `POSTHOG_API_KEY`
- `POSTHOG_HOST`
- `ALTTEXT_AI_STRIPE_PRICE_PRO`
- `ALTTEXT_AI_STRIPE_PRICE_AGENCY`
- `ALTTEXT_AI_STRIPE_PRICE_CREDITS`
- `JWT_SECRET`
- `OPENAI_API_KEY`
- `PORT`
- `ALLOWED_ORIGINS` (comma-separated)
- Optional: `ADMIN_KEY`, `ALT_API_TOKEN`, `FRONTEND_URL`, `FRONTEND_DASHBOARD_URL`
- Optional: `RATE_LIMIT_PER_SITE`, `RATE_LIMIT_GLOBAL`, `JOB_CONCURRENCY`, `JOB_TTL_SECONDS`, `SKIP_QUOTA_CHECK_SITE_IDS`

## API
- `POST /api/alt-text`
  - Body:
    ```json
    {
      "image": { "base64": "…", "width": 600, "height": 400, "mime_type": "image/jpeg" },
      "context": { "title": "Hero banner", "pageTitle": "Home" }
    }
    ```
  - Returns `{ altText, warnings[], usage, meta }`
  - Auth (optional): set `ALT_API_TOKEN` and send `Authorization: Bearer <token>` or `X-API-Key: <token>`. For per-site limits, send `X-Site-Key: <siteId>`.
  - CORS: lock to `ALLOWED_ORIGINS` if set.
  - Rate limit: `RATE_LIMIT_PER_SITE` per minute (per `X-Site-Key`), optional `RATE_LIMIT_GLOBAL` for all sites.
  - Cache: deduplication by base64 hash; Redis-backed if `REDIS_URL` is set, otherwise in-memory.
  - Batch queue: `POST /api/jobs` with `{ images: [{ image, context? }], context? }`; poll `/api/jobs/:jobId`. Queue and job records use Redis if available; otherwise in-memory.
- `POST /api/usage` (site summary, optional per-user breakdown with `X-WP-User-ID`/`X-WP-User-Email`; headers: `X-Site-Key` and bearer if token mode enabled)
- `GET /billing/plans` (public)
- `POST /billing/checkout` (token + `X-Site-Key`; creates Stripe checkout session)
- `POST /billing/webhook` (Stripe webhook; must receive the raw request body)
- `POST /billing/portal` (token + `X-Site-Key`; requires `customerId`)
- `GET /billing/subscription` (token + `X-Site-Key`; optional)
- `GET /ready` - basic readiness (redis + supabase presence)

## Notes
- Health: `GET /health`
- Readiness: `GET /ready` (checks redis ping and supabase presence)
- Headers: use `X-Site-Key` for site context; optional bearer/API token for protected routes
- Validation is gentle: only blocks clearly bad payloads (invalid base64 or >512KB); otherwise returns warnings.
- Optional Redis for cache/rate limit/queue: set `REDIS_URL`.

## Smoke
```bash
npm run smoke   # curls health, ready, billing/plans, usage, alt-text
```
