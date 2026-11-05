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
const { createInternalLinkingRouter } = require('./routes/internalLinking');
const { createContentRefreshRouter } = require('./routes/contentRefresh');
const { createAccountDashboardRouter } = require('./routes/accountDashboard');
const { createAnalyticsRouter } = require('./routes/analytics');
const { createLoopsWebhookHandler } = require('./routes/loopsWebhook');
const { createV1Router } = require('./routes/v1');
const { inspectV2Schema, logV2SchemaStartupStatus } = require('./services/v2Diagnostics');
const {
  getRuntimeIdentity,
  logRuntimeIdentityStartup,
  logSupabaseTargetStartup
} = require('./services/dataIntegrityDiagnostics');
const { getBillingPlansJson, getBillingPlansJsonLive } = require('./services/billingPlansCatalog');
const {
  resolveBillingCountry,
  resolveBillingCurrency,
  selectCatalogPriceIds
} = require('./lib/billingCurrency');
const { buildBillingHealth } = require('./services/billingHealth');
const { scheduleCustomerHealthCron } = require('./services/customerHealthTelemetry');
const { scheduleGenerationReservationRecovery } = require('./services/generationReservationRecovery');
const rateLimitMiddleware = require('./middleware/rateLimit');
const { authMiddleware } = require('./middleware/auth');
const { safeLogPath } = require('./lib/logPath');
const requestId = require('./middleware/requestId');
const { createProxyHopObserver, resolveTrustProxyHops } = require('./lib/trustProxy');
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
  '/api/optimizer',
  '/api/internal-linking',
  '/api/content-refresh'
];
