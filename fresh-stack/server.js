require('../config/env');

const express = require('express');
const compression = require('compression');
const helmet = require('helmet');
const cors = require('cors');
const config = require('../config/config');
const { getRedis } = require('./lib/redis');
const logger = require('./lib/logger');
const { createQueue } = require('./lib/queue');
const { createBulkAltTextProcessor } = require('./services/bulkAltTextProcessor');
const { createBulkTitlesProcessor } = require('./services/bulkTitlesProcessor');
const { createAuthRouter } = require('./routes/auth');
const { createBillingRouter, createBillingWebhookHandler } = require('./routes/billing');
const { createUsageRouter } = require('./routes/usage');
const { createAltTextRouter } = require('./routes/altText');
const { createTitlesRouter } = require('./routes/titles');
const { createReviewRouter } = require('./routes/review');
const { createJobsRouter } = require('./routes/jobs');
const { createLicenseRouter } = require('./routes/license');
const { createDashboardRouter } = require('./routes/dashboard');
const { createAdminRouter } = require('./routes/admin');
const { createContactRouter } = require('./routes/contact');
const { createImageSeoAuditRouter } = require('./routes/imageSeoAudit');
const { createOptimizerRouter } = require('./routes/optimizer');
const { inspectV2Schema, logV2SchemaStartupStatus } = require('./services/v2Diagnostics');
const {
  getRuntimeIdentity,
  logRuntimeIdentityStartup,
  logSupabaseTargetStartup
} = require('./services/dataIntegrityDiagnostics');
const { getBillingPlansJson, getBillingPlansJsonLive } = require('./services/billingPlansCatalog');
const { buildBillingHealth } = require('./services/billingHealth');
const { scheduleCustomerHealthCron } = require('./services/customerHealthTelemetry');
const rateLimitMiddleware = require('./middleware/rateLimit');
const { authMiddleware } = require('./middleware/auth');
const requestId = require('./middleware/requestId');
const errorHandler = require('./middleware/errorHandler');
const { getStripe } = require('./lib/stripe');

const PORT = config.port;
const HOST = config.host;
const JOB_CONCURRENCY = Number(process.env.JOB_CONCURRENCY || config.jobs?.concurrency || 2);
const JOB_TTL_SECONDS = Number(process.env.JOB_TTL_SECONDS || config.jobs?.ttlSeconds || 60 * 60 * 24 * 7);
const BULK_ITEM_CONCURRENCY = Number(process.env.BULK_ITEM_CONCURRENCY || 3);
const BULK_JOB_DISPATCH = String(process.env.BULK_JOB_DISPATCH || 'immediate').toLowerCase() === 'redis'
  ? 'redis'
  : 'immediate';
const DIAGNOSTICS_ROUTE_ENABLED = true;
const PROTECTED_API_PREFIXES = [
  '/api/alt-text',
  '/api/billing',
  '/api/contact',
  '/api/dashboard',
  '/api/jobs',
  '/api/license',
  '/api/licenses',
  '/api/review',
  '/api/titles',
  '/api/usage',
  '/api/auth',
  '/api/optimizer'
];

let supabase = null;
logger.info('[init] Supabase env check', {
  NODE_ENV: process.env.NODE_ENV || '(not set)',
  SUPABASE_URL_set: Boolean(process.env.SUPABASE_URL),
  SUPABASE_SERVICE_ROLE_KEY_set: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
  SUPABASE_URL_length: (process.env.SUPABASE_URL || '').length,
  SUPABASE_SERVICE_ROLE_KEY_length: (process.env.SUPABASE_SERVICE_ROLE_KEY || '').length,
  SUPABASE_URL_prefix: (process.env.SUPABASE_URL || '').substring(0, 30) || '(empty)',
});
try {
  const supabaseClient = require('../db/supabase-client');
  supabase = supabaseClient.supabase || supabaseClient;
  if (supabase && typeof supabase.from === 'function') {
    logger.info('[init] Supabase client initialized successfully');
  } else {
    logger.error('[init] Supabase client loaded but is not a valid client object', { type: typeof supabase });
    supabase = null;
  }
} catch (initError) {
  logger.error('[init] Supabase client init failed', { error: initError.message, stack: initError.stack });
  supabase = null;
}

if (!supabase) {
  logger.error('[init] Supabase client unavailable. Check SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY environment variables.');
}

function buildRuntimeIdentity() {
  return getRuntimeIdentity({
    diagnosticsRouteEnabled: DIAGNOSTICS_ROUTE_ENABLED
  });
}

function createApp({
  supabaseClient = supabase,
  redisClient = getRedis(),
  adminResultCache = new Map(),
  altTextResultCache = new Map()
} = {}) {
  const app = express();
  const redis = redisClient;
  const allowedOrigins = config.allowedOrigins;
  const priceIds = config.stripePrices;
  const queueKey = 'alttext:queue';
  const altTextRateLimits = new Map();
  const runtimeIdentityProvider = () => buildRuntimeIdentity();

  app.locals.runtimeIdentityProvider = runtimeIdentityProvider;
  app.locals.diagnosticsRouteEnabled = DIAGNOSTICS_ROUTE_ENABLED;

  app.use(cors({
    origin: allowedOrigins.length ? allowedOrigins : (config.isProd ? false : true),
    credentials: true
  }));

  app.use(compression());
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(requestId());

  // Stripe webhook must run before the global JSON parser so signature verification
  // receives the raw request body from Stripe.
  app.post(
    '/billing/webhook',
    express.raw({ type: 'application/json', limit: '2mb' }),
    createBillingWebhookHandler({ supabase: supabaseClient, getStripe, priceIds })
  );

  app.use(express.json({ limit: '8mb' }));

  app.get('/', (_req, res) => {
    const runtime = runtimeIdentityProvider();
    res.json({
      service: runtime.service_name,
      version: runtime.app_version,
      status: 'running',
      endpoints: {
        health: '/health',
        ready: '/ready',
        diagnostics: '/admin/diagnostics/data-integrity'
      },
      runtime
    });
  });

  app.get('/health', (_req, res) => {
    const runtime = runtimeIdentityProvider();
    const dbOk = Boolean(supabaseClient);
    if (!dbOk) {
      return res.status(503).json({
        ok: false,
        service: runtime.service_name,
        time: new Date().toISOString(),
        error: 'DATABASE_UNAVAILABLE',
        message: 'Supabase client not initialized',
        runtime
      });
    }
    return res.json({
      ok: true,
      service: runtime.service_name,
      time: new Date().toISOString(),
      runtime
    });
  });

  app.get('/ready', async (_req, res) => {
    const redisRequired = BULK_JOB_DISPATCH === 'redis';
    const checks = { redis: !!redis, redis_required: redisRequired, supabase: !!supabaseClient };
    try {
      if (redis) await redis.ping();
    } catch (_error) {
      checks.redis = false;
    }
    return res.json({
      ready: checks.supabase && (!redisRequired || checks.redis),
      ...checks,
      runtime: runtimeIdentityProvider()
    });
  });

  async function sendPublicBillingPlans(req, res) {
    const t0 = Date.now();
    try {
      const body = await getBillingPlansJsonLive(priceIds, getStripe);
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

  // Fast "can checkout work right now?" probe for support/diagnostics.
  // Booleans only (no secrets) so it stays unauthenticated like /billing/plans.
  async function sendBillingHealth(req, res) {
    try {
      const health = await buildBillingHealth({ priceIds, getStripe, supabase: supabaseClient });
      res.set('Cache-Control', 'no-store');
      res.json(health);
    } catch (err) {
      logger.error('[billing/health] error', { path: req.path, error: err.message });
      res.status(500).json({
        stripe: false, starter: false, pro: false, entitlements: false,
        timestamp: new Date().toISOString()
      });
    }
  }

  app.get('/billing/health', sendBillingHealth);
  app.get('/api/billing/health', sendBillingHealth);

  app.use(rateLimitMiddleware({
    redis,
    perSiteOverride: config.rateLimit.perSite,
    globalOverride: config.rateLimit.global
  }));

  app.use('/auth', createAuthRouter({ supabase: supabaseClient }));
  app.use('/api/auth', createAuthRouter({ supabase: supabaseClient }));

  app.use('/admin', createAdminRouter({
    redis,
    supabase: supabaseClient,
    resultCache: adminResultCache,
    runtimeIdentityProvider
  }));

  app.use('/api/contact', createContactRouter({ redis }));
  app.use('/api/image-seo-audit', createImageSeoAuditRouter({ supabase: supabaseClient }));

  app.use((req, res, next) => {
    if (req.path === '/api/billing/webhook') {
      return res.status(404).json({
        success: false,
        error: 'NOT_FOUND',
        code: 'NOT_FOUND',
        message: `Cannot ${req.method} ${req.originalUrl}`
      });
    }

    if (
      req.path.startsWith('/api/')
      && !PROTECTED_API_PREFIXES.some((prefix) => req.path === prefix || req.path.startsWith(`${prefix}/`))
    ) {
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

    return next();
  });

  app.use(authMiddleware({ supabase: supabaseClient }));

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

  async function getSiteFromHeaders(req) {
    const siteHash = req.header('X-Site-Hash') || req.header('X-Site-Key');
    if (!siteHash || !supabaseClient) return null;

    try {
      const { data } = await supabaseClient
        .from('sites')
        .select('*')
        .eq('site_hash', siteHash)
        .single();
      return data;
    } catch (_error) {
      return null;
    }
  }

  const licenseRouter = createLicenseRouter({ supabase: supabaseClient });
  app.use('/license', licenseRouter);
  app.use('/api/license', licenseRouter);
  app.use('/api/licenses', licenseRouter);
  app.use('/api/usage', createUsageRouter({ supabase: supabaseClient }));
  app.use('/api/alt-text', createAltTextRouter({
    supabase: supabaseClient,
    redis,
    resultCache: altTextResultCache,
    checkRateLimit,
    getSiteFromHeaders
  }));

  const reviewRouter = createReviewRouter({ supabase: supabaseClient });
  app.use('/api/review', reviewRouter);

  // Oppti Optimizer plugin — site audit start/poll/history. Auth via the same
  // license / JWT / anonymous-trial rails as alt-text (see middleware/auth.js).
  app.use('/api/optimizer', createOptimizerRouter({ supabase: supabaseClient }));

  const queueHolder = { q: null };
  const bulkProcessor = createBulkAltTextProcessor({
    supabase: supabaseClient,
    getJobRecord: (id) => queueHolder.q.getJobRecord(id),
    setJobRecord: (id, rec) => queueHolder.q.setJobRecord(id, rec),
    itemConcurrency: BULK_ITEM_CONCURRENCY
  });
  const bulkTitlesProcessor = createBulkTitlesProcessor({
    supabase: supabaseClient,
    getJobRecord: (id) => queueHolder.q.getJobRecord(id),
    setJobRecord: (id, rec) => queueHolder.q.setJobRecord(id, rec),
    itemConcurrency: BULK_ITEM_CONCURRENCY
  });

  async function dispatchBulkJob(job) {
    if (job.type === 'bulk_titles') {
      await bulkTitlesProcessor.run(job);
      return;
    }
    await bulkProcessor.run(job);
  }

  const queue = createQueue({
    redis,
    concurrency: JOB_CONCURRENCY,
    ttlSeconds: JOB_TTL_SECONDS,
    queueKey,
    bulkDispatchMode: BULK_JOB_DISPATCH,
    bulkRunner: (job) => dispatchBulkJob(job),
    jobHandler: async (job) => {
      await dispatchBulkJob(job);
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
    supabase: supabaseClient,
    checkRateLimit: async (siteKey) => checkRateLimit(siteKey),
    getSiteFromHeaders,
    createJob: queue.createJob,
    getJobRecord: queue.getJobRecord
  }));

  app.use('/api/titles', createTitlesRouter({
    supabase: supabaseClient,
    checkRateLimit: async (siteKey) => checkRateLimit(siteKey),
    getSiteFromHeaders,
    createJob: queue.createJob,
    getJobRecord: queue.getJobRecord
  }));

  const billingRouterInstance = createBillingRouter({
    supabase: supabaseClient,
    getStripe,
    priceIds
  });
  app.use('/billing', billingRouterInstance);
  app.use('/api/billing', billingRouterInstance);

  const dashboardRouterInstance = createDashboardRouter({
    supabase: supabaseClient,
    getJobRecord: queue.getJobRecord
  });
  app.use('/dashboard', dashboardRouterInstance);
  app.use('/api/dashboard', dashboardRouterInstance);

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

  app.use(errorHandler());

  return app;
}

function startServer({
  port = PORT,
  host = HOST,
  app = createApp(),
  supabaseClient = supabase
} = {}) {
  if (!supabaseClient) {
    logger.error('[init] Cannot start server: Supabase client is not initialized. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.');
    process.exit(1);
  }
  return app.listen(port, host, async () => {
    logger.info(`Fresh alt-text service running on http://${host}:${port}`);
    logRuntimeIdentityStartup({
      diagnosticsRouteEnabled: DIAGNOSTICS_ROUTE_ENABLED
    });
    logSupabaseTargetStartup();

    if (supabaseClient) {
      try {
        const v2SchemaReport = await inspectV2Schema(supabaseClient);
        logV2SchemaStartupStatus(v2SchemaReport);
      } catch (err) {
        logger.warn('[init] V2 schema probe failed (non-fatal)', { error: err.message });
      }

      scheduleCustomerHealthCron(supabaseClient);
    }
  });
}

if (require.main === module) {
  startServer();
}

module.exports = {
  createApp,
  startServer
};
