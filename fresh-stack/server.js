require('../config/env');

console.log('[env] Stripe key:', process.env.STRIPE_SECRET_KEY?.slice(0, 10));

const express = require('express');
const compression = require('compression');
const helmet = require('helmet');
const cors = require('cors');
const config = require('../config/config');
const { getRedis } = require('./lib/redis');
const logger = require('./lib/logger');
const { createQueue } = require('./lib/queue');
const { createBulkAltTextProcessor } = require('./services/bulkAltTextProcessor');
const { createAuthRouter } = require('./routes/auth');
const { createBillingRouter, createBillingWebhookHandler } = require('./routes/billing');
const { createUsageRouter } = require('./routes/usage');
const { createAltTextRouter } = require('./routes/altText');
const { createReviewRouter } = require('./routes/review');
const { createJobsRouter } = require('./routes/jobs');
const { createLicenseRouter } = require('./routes/license');
const { createDashboardRouter } = require('./routes/dashboard');
const { createAdminRouter } = require('./routes/admin');
const { createContactRouter } = require('./routes/contact');
const { inspectV2Schema, logV2SchemaStartupStatus } = require('./services/v2Diagnostics');
const { getBillingPlansJson } = require('./services/billingPlansCatalog');
const rateLimitMiddleware = require('./middleware/rateLimit');
const { authMiddleware } = require('./middleware/auth');
const requestId = require('./middleware/requestId');
const errorHandler = require('./middleware/errorHandler');
const { getStripe } = require('./lib/stripe');

// Supabase client
let supabase = null;
try {
  const supabaseClient = require('../db/supabase-client');
  supabase = supabaseClient.supabase || supabaseClient;
  if (supabase) {
    logger.info('[init] Supabase client initialized');
  }
} catch (e) {
  logger.warn('[init] Supabase client not available; API functionality limited');
}

const app = express();
const redis = getRedis();

const PORT = config.port;
const HOST = config.host;

// CORS
const allowedOrigins = config.allowedOrigins;
app.use(cors({
  origin: allowedOrigins.length ? allowedOrigins : (config.isProd ? false : true),
  credentials: true
}));

app.use(compression());
app.use(helmet({ contentSecurityPolicy: false }));
app.use(requestId());

const priceIds = config.stripePrices;

// Stripe webhook must run before the global JSON parser so signature verification
// receives the raw request body from Stripe.
app.post(
  '/billing/webhook',
  express.raw({ type: 'application/json', limit: '2mb' }),
  createBillingWebhookHandler({ supabase, getStripe, priceIds })
);

app.use(express.json({ limit: '8mb' }));

// Health & root
app.get('/', (_req, res) => res.json({ 
  service: 'alttext-ai-api', 
  version: '2.0.0',
  status: 'running',
  endpoints: {
    health: '/health',
    ready: '/ready',
    docs: '/docs'
  }
}));
app.get('/health', (_req, res) => res.json({ ok: true, service: 'alttext-fresh', time: new Date().toISOString() }));
app.get('/ready', async (_req, res) => {
  const checks = { redis: !!redis, supabase: !!supabase };
  try {
    if (redis) await redis.ping();
  } catch (e) {
    checks.redis = false;
  }
  return res.json({ ready: checks.redis && checks.supabase, ...checks });
});

/**
 * Public plan catalog — registered before rate-limit/auth so plugins never wait on Redis or license
 * validation. Same payload as GET /billing/plans on the billing router (shared cache module).
 * /api/billing/plans: common plugin expectation when API base URL includes /api.
 */
function sendPublicBillingPlans(req, res) {
  const t0 = Date.now();
  try {
    const body = getBillingPlansJson(priceIds);
    res.set('Cache-Control', 'public, max-age=300');
    res.json(body);
    logger.info('[billing/plans] served', {
      path: req.path,
      duration_ms: Date.now() - t0,
      source: 'early_route'
    });
  } catch (err) {
    logger.error('[billing/plans] error', { path: req.path, error: err.message });
    res.status(500).json({
      success: false,
      error: 'PLANS_UNAVAILABLE',
      code: 'PLANS_UNAVAILABLE',
      message: err.message || 'Unable to load plans'
    });
  }
}

app.get('/billing/plans', sendPublicBillingPlans);
app.get('/api/billing/plans', sendPublicBillingPlans);

// Rate limit (before auth/routes)
app.use(rateLimitMiddleware({
  redis,
  perSiteOverride: config.rateLimit.perSite,
  globalOverride: config.rateLimit.global
}));

// Auth routes (public - no auth required)
app.use('/auth', createAuthRouter({ supabase }));
// Backwards/alternate path used by some clients/plugins.
app.use('/api/auth', createAuthRouter({ supabase }));

// Admin routes (public - protected by admin key, not license)
app.use('/admin', createAdminRouter({ redis, supabase, resultCache: new Map() }));

// Contact form route (public - requires site headers for abuse prevention, not full auth)
app.use('/api/contact', createContactRouter({ redis }));

// Auth for protected routes (license-key or API token)
app.use(authMiddleware({ supabase }));

// Per-site rate limiting for alt-text: Redis if available, else in-memory fallback
async function checkRateLimit(siteKey) {
  const windowMs = 60_000;
  const limit = 60;
  if (redis) {
    const window = Math.floor(Date.now() / windowMs);
    const key = `alttext:ratelimit:${siteKey}:${window}`;
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, 120);
    return count <= limit;
  }
  const now = Date.now();
  const windowStart = now - windowMs;
  const hits = altTextRateLimits.get(siteKey) || [];
  const recent = hits.filter((ts) => ts >= windowStart);
  recent.push(now);
  altTextRateLimits.set(siteKey, recent);
  if (Math.random() < 0.01) {
    for (const [key, times] of altTextRateLimits.entries()) {
      const filtered = times.filter((ts) => ts >= windowStart);
      if (filtered.length === 0) altTextRateLimits.delete(key);
      else altTextRateLimits.set(key, filtered);
    }
  }
  return recent.length <= limit;
}
const altTextRateLimits = new Map();

// Helper function to get site from headers
async function getSiteFromHeaders(supabase, req) {
  const siteHash = req.header('X-Site-Hash') || req.header('X-Site-Key');
  if (!siteHash) return null;
  
  try {
    const { data } = await supabase
      .from('sites')
      .select('*')
      .eq('site_hash', siteHash)
      .single();
    return data;
  } catch (e) {
    return null;
  }
}

// Routers – license at /license (legacy) and /api/license, /api/licenses (frontend paths)
const licenseRouter = createLicenseRouter({ supabase });
app.use('/license', licenseRouter);
app.use('/api/license', licenseRouter);
app.use('/api/licenses', licenseRouter);
app.use('/api/usage', createUsageRouter({ supabase }));
// Trial + anonymous + single-image + regenerate: POST /api/alt-text (bulk licensed flow uses POST /api/jobs).
app.use('/api/alt-text', createAltTextRouter({
  supabase,
  redis,
  resultCache: new Map(),
  checkRateLimit,
  getSiteFromHeaders: async (req) => getSiteFromHeaders(supabase, req)
}));

// Alt-text review (licensed). Single router instance; POST /api/review → router POST /
const reviewRouter = createReviewRouter();
app.use('/api/review', reviewRouter);

// Bulk jobs: immediate dispatch by default (first image starts on API process via setImmediate).
// Set BULK_JOB_DISPATCH=redis to use the Redis list + workers (for multi-instance; workers start at boot).
const JOB_CONCURRENCY = Number(process.env.JOB_CONCURRENCY || config.jobs?.concurrency || 2);
const JOB_TTL_SECONDS = Number(process.env.JOB_TTL_SECONDS || config.jobs?.ttlSeconds || 60 * 60 * 24 * 7);
const BULK_ITEM_CONCURRENCY = Number(process.env.BULK_ITEM_CONCURRENCY || 3);
const BULK_JOB_DISPATCH = String(process.env.BULK_JOB_DISPATCH || 'immediate').toLowerCase() === 'redis'
  ? 'redis'
  : 'immediate';
const queueKey = 'alttext:queue';

const queueHolder = { q: null };
const bulkProcessor = createBulkAltTextProcessor({
  supabase,
  getJobRecord: (id) => queueHolder.q.getJobRecord(id),
  setJobRecord: (id, rec) => queueHolder.q.setJobRecord(id, rec),
  itemConcurrency: BULK_ITEM_CONCURRENCY
});

const queue = createQueue({
  redis,
  concurrency: JOB_CONCURRENCY,
  ttlSeconds: JOB_TTL_SECONDS,
  queueKey,
  bulkDispatchMode: BULK_JOB_DISPATCH,
  bulkRunner: (job) => bulkProcessor.run(job),
  jobHandler: async (job) => {
    if (job.type === 'bulk_alt_text') {
      await bulkProcessor.run(job);
    }
  }
});
queueHolder.q = queue;

if (redis && BULK_JOB_DISPATCH === 'redis') {
  queue.startRedisWorkers();
  logger.info('[init] bulk jobs use redis queue; workers started', {
    worker_concurrency: JOB_CONCURRENCY,
    bulk_item_concurrency: BULK_ITEM_CONCURRENCY
  });
} else {
  logger.info('[init] bulk jobs use immediate dispatch', {
    bulk_item_concurrency: BULK_ITEM_CONCURRENCY
  });
}

app.use('/api/jobs', createJobsRouter({
  supabase,
  checkRateLimit: async (siteKey) => checkRateLimit(siteKey),
  getSiteFromHeaders: async (req) => getSiteFromHeaders(supabase, req),
  createJob: queue.createJob,
  getJobRecord: queue.getJobRecord
}));

// Billing + dashboard
app.use('/billing', createBillingRouter({ supabase, getStripe, priceIds }));
app.use('/dashboard', createDashboardRouter({ supabase }));

// JSON 404/405-style responses for /api/* (never return Express HTML "Cannot POST …" to plugins)
app.use((req, res) => {
  if (res.headersSent) return;
  if (req.path.startsWith('/api')) {
    logger.warn('[api] unmatched_route', {
      method: req.method,
      path: req.path,
      originalUrl: req.originalUrl
    });
    return res.status(404).json({
      success: false,
      error: 'NOT_FOUND',
      code: 'NOT_FOUND',
      message: `Cannot ${req.method} ${req.originalUrl}`
    });
  }
  res.status(404).type('text/plain').send('Not Found');
});

// Error handler
app.use(errorHandler());

app.listen(PORT, HOST, async () => {
  logger.info(`Fresh alt-text service running on http://${HOST}:${PORT}`);

  if (supabase) {
    try {
      const v2SchemaReport = await inspectV2Schema(supabase);
      logV2SchemaStartupStatus(v2SchemaReport);
    } catch (err) {
      logger.warn('[init] V2 schema probe failed (non-fatal)', { error: err.message });
    }
  }
});
