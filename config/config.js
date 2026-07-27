const { getEnv, isProduction, isDevelopment, validateEnv } = require('./env');

validateEnv();

const DEFAULT_ALLOWED_ORIGINS = [
  'https://playground.wordpress.net'
];

const DEFAULT_ALLOWED_HEADERS = [
  'Accept',
  'Authorization',
  'Content-Type',
  'X-Correlation-ID',
  'X-Install-Hash',
  'X-License-Key',
  'X-PHP-Version',
  'X-Plugin-Channel',
  'X-Plugin-ID',
  'X-Plugin-Title',
  'X-Plugin-Version',
  'X-Request-Source',
  'X-Session-ID',
  'X-Signup-Attempt-ID',
  'X-Site-Fingerprint',
  'X-Site-Hash',
  'X-Site-Key',
  'X-Site-URL',
  'X-WP-Version'
];

function loadConfig() {
  const rateLimitPerSite = Number(getEnv('RATE_LIMIT_PER_SITE', 120));
  const rateLimitGlobal = Number(getEnv('RATE_LIMIT_GLOBAL', 0));
  const jobConcurrency = Number(getEnv('JOB_CONCURRENCY', 2));
  const jobTtlSeconds = Number(getEnv('JOB_TTL_SECONDS', 60 * 60 * 24 * 7));

  return {
    supabaseUrl: getEnv('SUPABASE_URL'),
    supabaseServiceRoleKey: getEnv('SUPABASE_SERVICE_ROLE_KEY'),
    stripeSecretKey: getEnv('STRIPE_SECRET_KEY'),
    stripePrices: {
      starter: getEnv('ALTTEXT_AI_STRIPE_PRICE_STARTER_MONTHLY') || getEnv('STRIPE_PRICE_STARTER_MONTHLY'),
      pro: getEnv('ALTTEXT_AI_STRIPE_PRICE_PRO'),
      agency: getEnv('ALTTEXT_AI_STRIPE_PRICE_AGENCY'),
      credits: getEnv('ALTTEXT_AI_STRIPE_PRICE_CREDITS')
    },
    openAiKey: getEnv('OPENAI_API_KEY') || getEnv('ALTTEXT_OPENAI_API_KEY'),
    openAiModel: getEnv('OPENAI_MODEL', 'gpt-4o-mini'),
    allowedOrigins: Array.from(new Set([
      ...(getEnv('ALLOWED_ORIGINS', '') || '')
        .split(',')
        .map((o) => o.trim())
        .filter(Boolean),
      ...DEFAULT_ALLOWED_ORIGINS
    ])),
    allowedHeaders: DEFAULT_ALLOWED_HEADERS,
    altApiToken: getEnv('ALT_API_TOKEN') || getEnv('API_TOKEN') || null,
    host: getEnv('HOST', '127.0.0.1'),
    port: Number(getEnv('PORT', 4000)),
    rateLimit: {
      perSite: rateLimitPerSite,
      global: rateLimitGlobal
    },
    jobs: {
      concurrency: jobConcurrency,
      ttlSeconds: jobTtlSeconds
    },
    isProd: isProduction(),
    isDev: isDevelopment()
  };
}

module.exports = loadConfig();
