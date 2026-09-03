const express = require('express');
const { z } = require('zod');
const logger = require('../lib/logger');
const { buildSiteIdentity } = require('../lib/siteIdentity');
const { extractUserInfo } = require('../middleware/auth');
const { generateInternalLinkSuggestions } = require('../lib/openaiInternalLinking');
const {
  INTERNAL_LINKING_FEATURE_TYPE,
  reserveInternalLinkingQuota,
  finalizeInternalLinkingQuota,
  getInternalLinkingQuotaStatus,
  buildInternalLinkingRequestFingerprint
} = require('../services/internalLinkingQuota');
const { recordUsage } = require('../services/usage');

const pageRefSchema = z.object({
  id: z.union([z.string(), z.number()]).optional().nullable(),
  url: z.string().max(2048).optional(),
  title: z.string().max(500).optional().nullable()
}).passthrough();

const sourceSchema = pageRefSchema.extend({
  content_excerpt: z.string().max(12000).optional().nullable()
});

const optionsSchema = z.object({
  max_suggestions: z.number().int().min(1).max(10).optional()
}).partial().optional();

const suggestSchema = z.object({
  source: sourceSchema,
  candidates: z.array(pageRefSchema).min(1).max(60),
  options: optionsSchema,
  idempotency_key: z.string().max(255).optional()
});

// One credit per source page analysed, drawn from the shared wallet. The number
// of suggestions returned does not change the cost — the analysis is the unit.
const CREDITS_PER_REQUEST = 1;

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
  return {
    feature_type: INTERNAL_LINKING_FEATURE_TYPE,
    credits_used: reservationPayload.credits_used ?? null,
    credits_remaining: reservationPayload.remaining_credits ?? reservationPayload.credits_remaining ?? null,
    total_limit: reservationPayload.total_limit ?? null,
    daily_remaining: reservationPayload.daily_remaining ?? reservationPayload.daily_generations_remaining ?? null,
    daily_limit: reservationPayload.daily_limit ?? reservationPayload.daily_generation_limit ?? null,
    plan: reservationPayload.plan ?? reservationPayload.plan_id ?? null,
    reset_date: reservationPayload.quota_period_end ?? reservationPayload.reset_date ?? null
  };
}

function createInternalLinkingRouter({ supabase, checkRateLimit } = {}) {
  const router = express.Router();

  router.post('/suggest', async (req, res) => {
    const parsed = suggestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        error: 'INVALID_REQUEST',
        code: 'INVALID_REQUEST',
        details: parsed.error.flatten()
      });
    }

    const { source, candidates, options = {}, idempotency_key: clientIdempotencyKey } = parsed.data;
    const licenseKey = resolveLicenseKey(req);
    if (!licenseKey) {
      return res.status(401).json({
        success: false,
        error: 'LICENSE_REQUIRED',
        code: 'LICENSE_REQUIRED',
        message: 'A valid license is required for internal link suggestions.'
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
    const requestFingerprint = buildInternalLinkingRequestFingerprint({
      siteKey,
      userInfo,
      source,
      candidates,
      options
    });
    const idempotencyKey = clientIdempotencyKey || `linking:${siteKey}:${requestFingerprint.slice(0, 32)}`;

    const reservation = await reserveInternalLinkingQuota(supabase, {
      account,
      licenseKey,
      siteIdentity,
      creditsNeeded: CREDITS_PER_REQUEST,
      idempotencyKey,
      requestFingerprint,
      requestMetadata: {
        endpoint: 'api/internal-linking/suggest',
        source_url: source.url || null,
        candidate_count: candidates.length,
        credits_per_request: CREDITS_PER_REQUEST,
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
      const result = await generateInternalLinkSuggestions({ source, candidates, options });
      const generationTimeMs = Date.now() - genStart;

      const finalizeResult = await finalizeInternalLinkingQuota(supabase, {
        generationRequestId,
        success: true,
        finalMetadata: {
          model_used: result.meta_info?.modelUsed || null,
          total_tokens: result.usage?.total_tokens || null,
          suggestion_count: result.suggestions.length
        }
      });

      await recordUsage(supabase, {
        licenseKey: effectiveLicenseKey,
        licenseId: account?.id || null,
        siteHash: effectiveSite?.site_hash || siteKey,
        siteUrl: req.header('X-Site-URL') || null,
        userEmail: userInfo?.user_email || null,
        pluginVersion: userInfo?.plugin_version,
        creditsUsed: CREDITS_PER_REQUEST,
        promptTokens: result.usage?.prompt_tokens,
        completionTokens: result.usage?.completion_tokens,
        totalTokens: result.usage?.total_tokens,
        cached: false,
        modelUsed: result.meta_info?.modelUsed || null,
        generationTimeMs,
        endpoint: 'api/internal-linking/suggest',
        status: 'success',
        featureType: INTERNAL_LINKING_FEATURE_TYPE,
        requestSource: req.header('X-Request-Source') || null,
        pluginChannel: req.header('X-Plugin-Channel') || null,
        environment: req.header('X-Environment') || null,
        requestId: req.id || null,
        userAgent: req.get('user-agent') || null
      });

      const entitlement = buildEntitlementSnapshot(reservation.reservation);

      return res.json({
        success: true,
        suggestions: result.suggestions,
        credits_used: CREDITS_PER_REQUEST,
        credits_remaining: entitlement?.credits_remaining ?? null,
        credits_total: entitlement?.total_limit ?? null,
        usage: result.usage || null,
        meta_info: result.meta_info || null,
        entitlement_state: entitlement,
        generation_request_id: generationRequestId,
        finalize_status: finalizeResult.data?.status || null
      });
    } catch (error) {
      await finalizeInternalLinkingQuota(supabase, {
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
        message: error.message || 'Internal link suggestion failed',
        retryable: Boolean(error.isRetryable)
      });
    }
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

    const status = await getInternalLinkingQuotaStatus(supabase, {
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
        message: status.message || 'Could not load internal linking quota'
      });
    }

    logger.info('[internal-linking.quota] served', { site_id: status.site_id || null });
    return res.json({ success: true, ...status });
  });

  return router;
}

module.exports = { createInternalLinkingRouter };
