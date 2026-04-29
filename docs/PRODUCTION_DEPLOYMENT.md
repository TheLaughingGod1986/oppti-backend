# Production deployment (BeepBeep AI backend)

This backend is an Express server designed to run on a **long‑running Node host** (Render or equivalent).

## Hosting model

- **Designed for**: Render (or any persistent Node/Express host)
- **Not Vercel-ready as-is**: there is **no** `vercel.json` and **no** serverless adapter entry in this repo.
- **Entry point**: `npm start` runs `fresh-stack/server.js`.
- **Why not Vercel by default**:
  - This service expects a long-running process.
  - Bulk jobs / worker concurrency and any Redis worker behavior must be reviewed carefully for serverless constraints.
  - Stripe webhooks require stable routing and raw body handling.
  - Do not attempt serverless deployment without a deliberate Express/serverless adapter and a fresh webhook/raw-body review.

## Render contract (current)

Render configuration lives in `render.yaml`:

- **Build**: `npm install`
- **Start**: `npm start`
- **Health check**: `GET /health`

## Stripe webhook route

Stripe webhook is mounted **only** at:

- `POST /billing/webhook`

Do **not** point Stripe at `/api/billing/webhook` unless you deliberately add a second webhook handler with the same **raw body** parsing behavior.

**Webhook URL format:**

- `https://YOUR-BACKEND-DOMAIN/billing/webhook`

## WordPress plugin backend origin

The WordPress plugin should point to the backend origin via:

- `define('BEEPBEEP_AI_API_URL', 'https://YOUR-BACKEND-DOMAIN');`

This ensures all plugin flows (auth, usage, dashboard state, generation) use the same backend host.
