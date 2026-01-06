const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const config = require('../config/config');
const { getRedis } = require('./lib/redis');
const logger = require('./lib/logger');
const { createQueue } = require('./lib/queue');
const { createAuthRouter } = require('./routes/auth');
const { createBillingRouter } = require('./routes/billing');
const { createUsageRouter } = require('./routes/usage');
const { createAltTextRouter } = require('./routes/altText');
const { createJobsRouter } = require('./routes/jobs');
const { createLicenseRouter } = require('./routes/license');
const { createDashboardRouter } = require('./routes/dashboard');
const { createAdminRouter } = require('./routes/admin');
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
  credentials: false
}));

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '8mb' }));
app.use(requestId());

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

// Rate limit (before auth/routes)
app.use(rateLimitMiddleware({
  redis,
  perSiteOverride: config.rateLimit.perSite,
  globalOverride: config.rateLimit.global
}));

// Auth routes (public - no auth required)
app.use('/auth', createAuthRouter({ supabase }));

// Admin routes (public - protected by admin key, not license)
app.use('/admin', createAdminRouter({ redis, resultCache: new Map() }));

// Auth for protected routes (license-key or API token)
app.use(authMiddleware({ supabase }));

// Helper function for per-site rate limiting used by alt-text route
const altTextRateLimits = new Map();
async function checkRateLimit(siteKey) {
  const windowMs = 60_000;
  const limit = 60; // Default limit per site per minute
  const now = Date.now();
  const windowStart = now - windowMs;
  
  const hits = altTextRateLimits.get(siteKey) || [];
  const recent = hits.filter((ts) => ts >= windowStart);
  recent.push(now);
  altTextRateLimits.set(siteKey, recent);
  
  // Clean up old entries periodically
  if (Math.random() < 0.01) {
    for (const [key, times] of altTextRateLimits.entries()) {
      const filtered = times.filter((ts) => ts >= windowStart);
      if (filtered.length === 0) {
        altTextRateLimits.delete(key);
      } else {
        altTextRateLimits.set(key, filtered);
      }
    }
  }
  
  return recent.length <= limit;
}

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

// Routers
app.use('/license', createLicenseRouter({ supabase }));
app.use('/api/usage', createUsageRouter({ supabase }));
app.use('/api/alt-text', createAltTextRouter({
  supabase,
  redis,
  resultCache: new Map(),
  checkRateLimit,
  getSiteFromHeaders: async (req) => getSiteFromHeaders(supabase, req)
}));

// Jobs queue
const JOB_CONCURRENCY = Number(process.env.JOB_CONCURRENCY || 2);
const JOB_TTL_SECONDS = 60 * 60 * 24 * 7;
const queueKey = 'alttext:queue';
const queue = createQueue({
  redis,
  concurrency: JOB_CONCURRENCY,
  ttlSeconds: JOB_TTL_SECONDS,
  queueKey,
  jobHandler: async (job) => {
    try {
      const record = await queue.getJobRecord(job.jobId);
      if (!record) return;
      record.status = 'running';
      await queue.setJobRecord(job.jobId, record);
      for (const item of job.items) {
        try {
          record.completed += 1;
        } catch (e) {
          record.failed += 1;
          logger.error('[queue] job item failed', { jobId: job.jobId, error: e.message });
        }
        await queue.setJobRecord(job.jobId, record);
      }
      record.status = 'completed';
      await queue.setJobRecord(job.jobId, record);
    } catch (err) {
      logger.error('[queue] job handler failed', { jobId: job?.jobId, error: err.message });
    }
  }
});

app.use('/api/jobs', createJobsRouter({
  supabase,
  checkRateLimit: async (siteKey) => checkRateLimit(siteKey),
  getSiteFromHeaders: async (req) => getSiteFromHeaders(supabase, req),
  createJob: queue.createJob,
  getJobRecord: queue.getJobRecord
}));

// Billing + dashboard
const priceIds = config.stripePrices;
app.use('/billing', createBillingRouter({ supabase, getStripe, priceIds }));
app.use('/dashboard', createDashboardRouter({ supabase }));

// Error handler
app.use(errorHandler());

app.listen(PORT, HOST, () => {
  logger.info(`Fresh alt-text service running on http://${HOST}:${PORT}`);
});
