/**
 * Local development boot without secrets.
 *
 * Starts the API with no Supabase/Stripe env so the optimizer audit endpoints
 * (in-memory, crawl-based) can be exercised against local wp-env sites:
 *
 *   npm run dev:local
 *
 * - SKIP_ENV_VALIDATION: config no longer requires production env vars.
 * - OPTIMIZER_ALLOW_PRIVATE_URLS: lets audits crawl localhost (wp-env) sites.
 *   Never set this in production — it disables the SSRF guard for audits.
 * - Anything needing the database (licenses, billing, alt-text generation)
 *   degrades or 401s; the anonymous-trial auth path works for audits.
 */
process.env.SKIP_ENV_VALIDATION = process.env.SKIP_ENV_VALIDATION || 'true';
process.env.NODE_ENV = process.env.NODE_ENV || 'development';
process.env.OPTIMIZER_ALLOW_PRIVATE_URLS = process.env.OPTIMIZER_ALLOW_PRIVATE_URLS || 'true';

const PORT = Number(process.env.PORT || 4000);
const HOST = process.env.HOST || '127.0.0.1';

const { createApp } = require('../server');

createApp({ supabaseClient: null }).listen(PORT, HOST, () => {
  // eslint-disable-next-line no-console
  console.log(`[dev-local] API running on http://${HOST}:${PORT} (no DB, private URLs allowed for audits)`);
});
