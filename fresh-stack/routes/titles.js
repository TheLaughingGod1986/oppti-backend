const express = require('express');
const { z } = require('zod');
const logger = require('../lib/logger');
const { buildSiteIdentity } = require('../lib/siteIdentity');
const { extractUserInfo } = require('../middleware/auth');
const { generateTitleAndMeta } = require('../lib/openaiTitles');
const {
  TITLES_FEATURE_TYPE,
  reserveTitleGenerationQuota,
  finalizeTitleGenerationQuota,
  getTitleQuotaStatus,
  buildTitleRequestFingerprint
} = require('../services/titleQuota');
const { recordUsage } = require('../services/usage');

const pageSchema = z.object({
  url: z.string().max(2048).optional(),
  section: z.string().max(120).optional(),
  h1: z.string().max(500).optional(),
  current_title: z.string().max(500).optional().nullable(),
  current_meta: z.string().max(1000).optional().nullable(),
  content_excerpt: z.string().max(8000).optional(),
  id: z.union([z.string(), z.number()]).optional()
}).passthrough();

const optionsSchema = z.object({
  brand_name: z.string().max(120).optional(),
  tone: z.string().max(60).optional(),
  title_max_chars: z.number().int().min(20).max(120).optional(),
  meta_max_chars: z.number().int().min(60).max(320).optional()
}).partial().optional();

const previousSchema = z.object({
  title: z.string().optional(),
  meta: z.string().optional()
}).optional().nullable();

const generateSchema = z.object({
  page: pageSchema,
  options: optionsSchema,
  previous: previousSchema,
  idempotency_key: z.string().max(255).optional()
});

const bulkSchema = z.object({
  priority: z.enum(['high', 'normal', 'low']).optional(),
  pages: z.array(pageSchema).min(1).max(100),
  options: optionsSchema,
  context: z.any().optional()
});

function resolveLicenseKey(req) {
  return req.user?.license_key
    || req.license?.license_key
    || req.header('X-License-Key')
    || req.body?.license_key
    || null;
}

function resolveAccount(req) {
  return req.user || req.license || null;
}

function buildSiteIdentityFromRequest(req) {
  const hasAccountAuth = Boolean(
    req.user
    || req.license
    || req.header('X-License-Key')
    || req.header('Authorization')
  );
  return buildSiteIdentity({
    siteHash: req.header('X-Site-Hash') || req.header('X-Site-Key'),
    installUuid: req.header('X-Install-Hash')
      || req.header('X-Install-UUID')
      || req.header('X-WP-Install-UUID'),
    siteUrl: req.header('X-Site-URL'),
    siteFingerprint: req.header('X-Site-Fingerprint'),
    allowDevelopment: hasAccountAuth
  });
}

function siteKeyFromRequest(req) {
  return req.header('X-Site-Hash') || req.header('X-Site-Key') || 'default';
}

function buildEntitlementSnapshot(reservationPayload) {
  if (!reservationPayload) return null;
  // Tolerant of both the titles field names and the shared alt-text RPC's
  // field names (remaining_credits/daily_generations_remaining/plan_id).
  return {
    feature_type: TITLES_FEATURE_TYPE,
    credits_used: reservationPayload.credits_used ?? null,
    credits_remaining: reservationPayload.remaining_credits ?? reservationPayload.credits_remaining ?? null,
    total_limit: reservationPayload.total_limit ?? null,
    daily_remaining: reservationPayload.daily_remaining ?? reservationPayload.daily_generations_remaining ?? null,
    daily_limit: reservationPayload.daily_limit ?? reservationPayload.daily_generation_limit ?? null,
    plan: reservationPayload.plan ?? reservationPayload.plan_id ?? null,
    reset_date: reservationPayload.quota_period_end ?? reservationPayload.reset_date ?? null
  };
}

// Credits charged per page when generating both a title and a meta description
// (title = 1 credit, meta = 1 credit). Drawn from the shared wallet.
const CREDITS_PER_PAGE = 2;

function createTitlesRouter({
  supabase,
  checkRateLimit,
  getSiteFromHeaders, // eslint-disable-line no-unused-vars
  createJob,
  getJobRecord
}) {
  const router = express.Router();

  router.post('/generate', async (req, res) => {
    const parsed = generateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        error: 'INVALID_REQUEST',
        code: 'INVALID_REQUEST',
        details: parsed.error.flatten()
      });
    }

    const { page, options = {}, previous = null, idempotency_key: clientIdempotencyKey } = parsed.data;
    const licenseKey = resolveLicenseKey(req);
    if (!licenseKey) {
      return res.status(401).json({
        success: false,
        error: 'LICENSE_REQUIRED',
        code: 'LICENSE_REQUIRED',
        message: 'A valid license is required for title generation.'
      });
    }

    const siteKey = siteKeyFromRequest(req);
    const siteIdentity = buildSiteIdentityFromRequest(req);
    if (siteIdentity.error) {
      return res.status(403).json({
        success: false,
        error: siteIdentity.error,
        code: siteIdentity.error,
        message: 'Site identity could not be resolved.'
      });
    }

    if (typeof checkRateLimit === 'function' && !(await checkRateLimit(siteKey))) {
      return res.status(429).json({
        success: false,
        error: 'RATE_LIMIT_EXCEEDED',
        code: 'RATE_LIMIT_EXCEEDED',
        message: 'Rate limit exceeded'
      });
    }

    const userInfo = extractUserInfo(req);
    const account = resolveAccount(req);
    const requestFingerprint = buildTitleRequestFingerprint({
      siteKey,
      userInfo,
      page,
      options,
      previous
    });
    const idempotencyKey = clientIdempotencyKey || `titles:${siteKey}:${requestFingerprint.slice(0, 32)}`;

    const reservation = await reserveTitleGenerationQuota(supabase, {
      account,
      licenseKey,
      siteIdentity,
      creditsNeeded: CREDITS_PER_PAGE,
      idempotencyKey,
      requestFingerprint,
      requestMetadata: {
        endpoint: 'api/titles/generate',
        page_url: page.url || null,
        regenerate: Boolean(previous && (previous.title || previous.meta)),
        credits_per_page: CREDITS_PER_PAGE,
        wp_user_id: userInfo?.user_id || null
      },
      requestId: req.id || null
    });

    if (reservation.error) {
      const statusCode = reservation.status || 402;
      return res.status(statusCode).json({
        success: false,
        error: reservation.error,
        code: reservation.error,
        message: reservation.message || 'Quota denied',
        ...(reservation.payload ? { entitlement_state: buildEntitlementSnapshot(reservation.payload) } : {})
      });
    }

    const generationRequestId = reservation.reservation?.generation_request_id || null;
    const effectiveSite = reservation.site || null;
    const effectiveLicenseKey = effectiveSite?.license_key || licenseKey;

    const genStart = Date.now();
    try {
      const result = await generateTitleAndMeta({ page, options, previous });
      const generationTimeMs = Date.now() - genStart;

      const finalizeResult = await finalizeTitleGenerationQuota(supabase, {
        generationRequestId,
        success: true,
        finalMetadata: {
          model_used: result.meta_info?.modelUsed || null,
          total_tokens: result.usage?.total_tokens || null,
          regenerated: Boolean(previous)
        }
      });

      await recordUsage(supabase, {
        licenseKey: effectiveLicenseKey,
        licenseId: account?.id || null,
        siteHash: effectiveSite?.site_hash || siteKey,
        siteUrl: req.header('X-Site-URL') || null,
        userEmail: userInfo?.user_email || null,
        pluginVersion: userInfo?.plugin_version,
        creditsUsed: CREDITS_PER_PAGE,
        promptTokens: result.usage?.prompt_tokens,
        completionTokens: result.usage?.completion_tokens,
        totalTokens: result.usage?.total_tokens,
        cached: false,
        modelUsed: result.meta_info?.modelUsed || null,
        generationTimeMs,
        endpoint: 'api/titles/generate',
        status: 'success',
        featureType: TITLES_FEATURE_TYPE,
        requestSource: req.header('X-Request-Source') || null,
        pluginChannel: req.header('X-Plugin-Channel') || null,
        environment: req.header('X-Environment') || null,
        requestId: req.id || null,
        userAgent: req.get('user-agent') || null
      });

      const entitlement = buildEntitlementSnapshot(reservation.reservation);

      return res.json({
        success: true,
        title: result.title,
        meta: result.meta,
        credits_used: CREDITS_PER_PAGE,
        credits_remaining: entitlement?.credits_remaining ?? null,
        credits_total: entitlement?.total_limit ?? null,
        usage: result.usage || null,
        meta_info: result.meta_info || null,
        entitlement_state: entitlement,
        generation_request_id: generationRequestId,
        finalize_status: finalizeResult.data?.status || null
      });
    } catch (error) {
      await finalizeTitleGenerationQuota(supabase, {
        generationRequestId,
        success: false,
        finalMetadata: {
          error_message: error.message || 'Generation failed',
          error_code: error.code || 'GENERATION_FAILED'
        }
      });

      const status = error.httpStatus
        || (error.code === 'BACKEND_CONFIG_ERROR' ? 500
          : error.code === 'UPSTREAM_RATE_LIMITED' ? 429
            : error.code === 'UPSTREAM_GENERATION_ERROR' ? 502
              : 502);

      return res.status(status).json({
        success: false,
        error: error.code || 'GENERATION_FAILED',
        code: error.code || 'GENERATION_FAILED',
        message: error.message || 'Title generation failed',
        retryable: Boolean(error.isRetryable)
      });
    }
  });

  router.post('/jobs', async (req, res) => {
    const parsed = bulkSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        error: 'INVALID_REQUEST',
        code: 'INVALID_REQUEST',
        details: parsed.error.flatten()
      });
    }

    const { priority = 'normal', pages, options = {}, context = {} } = parsed.data;
    const licenseKey = resolveLicenseKey(req);
    if (!licenseKey) {
      return res.status(401).json({
        success: false,
        error: 'LICENSE_REQUIRED',
        code: 'LICENSE_REQUIRED',
        message: 'A valid license is required for title generation.'
      });
    }

    const siteKey = siteKeyFromRequest(req);
    const siteIdentity = buildSiteIdentityFromRequest(req);
    if (siteIdentity.error) {
      return res.status(403).json({
        success: false,
        error: siteIdentity.error,
        code: siteIdentity.error,
        message: 'Site identity could not be resolved.'
      });
    }

    const status = await getTitleQuotaStatus(supabase, {
      account: resolveAccount(req),
      licenseKey,
      siteIdentity,
      requestId: req.id || null
    });

    const requiredCredits = pages.length * CREDITS_PER_PAGE;
    if (!status.error && status.credits_remaining != null && status.credits_remaining < requiredCredits) {
      return res.status(402).json({
        success: false,
        error: 'QUOTA_EXCEEDED',
        code: 'QUOTA_EXCEEDED',
        required_credits: requiredCredits,
        credits_remaining: status.credits_remaining,
        message: 'Not enough credits for this batch',
        entitlement_state: status
      });
    }

    if (typeof checkRateLimit === 'function' && !(await checkRateLimit(siteKey))) {
      return res.status(429).json({
        success: false,
        error: 'RATE_LIMIT_EXCEEDED',
        code: 'RATE_LIMIT_EXCEEDED',
        message: 'Rate limit exceeded'
      });
    }

    const userInfo = extractUserInfo(req);
    const items = pages.map((page) => ({
      page,
      options,
      attachment_id: page.id != null ? String(page.id) : null,
      id: page.id != null ? String(page.id) : null,
      user: userInfo
    }));

    const jobId = await createJob(items, { ...context, options, priority }, siteKey, {
      licenseKey,
      userInfo,
      jobType: 'bulk_titles'
    });

    logger.info('[titles.jobs] bulk_job_accepted', {
      job_id: jobId,
      total_pages: pages.length,
      site_key: siteKey
    });

    return res.status(202).json({
      success: true,
      jobId,
      status: 'accepted',
      total: pages.length,
      completed: 0,
      failed: 0,
      priority,
      pollUrl: `/api/titles/jobs/${jobId}`
    });
  });

  router.get('/jobs/:jobId', async (req, res) => {
    const job = await getJobRecord(req.params.jobId);
    if (!job) {
      return res.status(404).json({ success: false, error: 'JOB_NOT_FOUND', code: 'JOB_NOT_FOUND', message: 'Job not found' });
    }
    if (job.type && job.type !== 'bulk_titles') {
      return res.status(404).json({ success: false, error: 'JOB_NOT_FOUND', code: 'JOB_NOT_FOUND', message: 'Job not found' });
    }
    const percentComplete = job.total
      ? Math.round((((job.completed || 0) + (job.failed || 0)) / job.total) * 100)
      : 0;
    return res.json({
      success: true,
      ...job,
      percentComplete
    });
  });

  router.get('/quota', async (req, res) => {
    const licenseKey = resolveLicenseKey(req);
    if (!licenseKey) {
      return res.status(401).json({
        success: false,
        error: 'LICENSE_REQUIRED',
        code: 'LICENSE_REQUIRED',
        message: 'A valid license is required.'
      });
    }
    const siteIdentity = buildSiteIdentityFromRequest(req);
    if (siteIdentity.error) {
      return res.status(403).json({
        success: false,
        error: siteIdentity.error,
        code: siteIdentity.error,
        message: 'Site identity could not be resolved.'
      });
    }

    const status = await getTitleQuotaStatus(supabase, {
      account: resolveAccount(req),
      licenseKey,
      siteIdentity,
      requestId: req.id || null
    });

    if (status.error) {
      return res.status(status.status || 500).json({
        success: false,
        error: status.error,
        code: status.error,
        message: status.message || 'Could not load title quota'
      });
    }

    return res.json({ success: true, ...status });
  });

  return router;
}

module.exports = { createTitlesRouter };
