# Oppti Backend

Production-ready Node.js backend API for Oppti services.

## Quick Start

```bash
npm install
cp .env.example .env
# Edit .env and add your API keys
npm start
```

## Tech Stack

- **Runtime:** Node.js 18+
- **Framework:** Express.js
- **Database:** Supabase (PostgreSQL)
- **Authentication:** JWT
- **Payment:** Stripe
- **Email:** Resend

## Environment Variables

See `.env.example` for the local development template and `config/env.example` for the expanded deployment reference. Key variables:

```env
# Supabase (Required)
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key

# Server / CORS (Required)
PORT=4000
ALLOWED_ORIGINS=https://your-site.com

# OpenAI (Required)
ALTTEXT_OPENAI_API_KEY=sk-...
SEO_META_OPENAI_API_KEY=sk-...

# JWT (Required)
JWT_SECRET=generate-a-long-random-secret

# Stripe (Required)
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...

# PostHog (Required for server-side payment tracking)
POSTHOG_API_KEY=phc_...
POSTHOG_HOST=https://us.i.posthog.com

# Admin (Recommended if using /admin endpoints)
ADMIN_KEY=generate-a-separate-admin-key

# Email (Required)
RESEND_API_KEY=re_...
EMAIL_FROM=OpttiAI <hello@optti.dev>
EMAIL_BRAND_NAME=OpttiAI
RESEND_FROM_EMAIL=noreply@yourdomain.com  # Legacy support, use EMAIL_FROM
RESEND_AUDIENCE_ID=aud_xxx  # Optional: For subscriber management
```

## Documentation

For detailed documentation, see the `/docs` directory:

- **[API Specification](docs/API_SPEC.md)** - Complete API endpoint documentation
- **[Database Schema](docs/DATABASE_SCHEMA.md)** - Database tables, relationships, and migrations
- **[Frontend Integration](docs/FRONTEND_INTEGRATION.md)** - Guide for frontend developers (includes license key setup)

## Development

```bash
# Install dependencies
npm install

# Run tests
npm test

# Run tests with coverage
npm test -- --coverage

# Start development server
npm start
```

## Utility Scripts

Development and testing utilities are in the `scripts/` folder:

- `scripts/test-supabase.js` - Test Supabase connection
- `scripts/setup-test-license.js` - Create a test license for development

Operator diagnostics:

```bash
# Local shell or any environment with backend env vars loaded
npm run diagnostics:data-integrity -- --pretty

# Render shell
node fresh-stack/scripts/print-data-integrity-diagnostics.js --pretty
```

The CLI prints the same diagnostics object used by `GET /admin/diagnostics/data-integrity` and only emits safe metadata such as runtime identity, Supabase host, schema presence, and row counts.

## License

Proprietary - Oppti
