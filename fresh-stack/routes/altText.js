const express = require('express');
const crypto = require('crypto');
const { z } = require('zod');
const logger = require('../lib/logger');
const { serializeSupabaseError } = require('../lib/supabaseErrors');
const { buildAnonymousContext } = require('../lib/anonymousIdentity');
const { validateImagePayload } = require('../lib/validation');
const { generateAltText } = require('../lib/openai');
const {
  buildAnonymousTrialStatus,
  getAnonymousTrialLimit,
  getAnonymousTrialStatus,
  isMissingSchemaError
} = require('../services/anonymousTrial');
const {
  finalizeGenerationQuotaReservation,
  getQuotaStatus,
  reserveGenerationQuota
} = require('../services/quota');
const { upsertGeneratedImageAltState } = require('../services/imageAltState');
const { recordUsage } = require('../services/usage');
const { findOrCreateTrialSite } = require('../services/site');
const { buildSiteIdentity } = require('../lib/siteIdentity');
const { hashRequestFingerprint } = require('../services/siteQuota');
const { extractUserInfo } = require('../middleware/auth');
const { buildTrialGenerationForSingleRequest } = require('../lib/trialGenerationContract');

function hashPayload(base64) {
  return crypto.createHash('md5').update(base64).digest('hex');
}

function hasValidAdminKey(adminKey) {
  return Boolean(process.env.ADMIN_KEY && adminKey && adminKey === process.env.ADMIN_KEY);
}

function extractIdempotencyKey(req) {
  return req.header('Idempotency-Key')
    || req.header('X-Idempotency-Key')
    || req.body?.idempotency_key
    || req.body?.idempotencyKey
    || null;
}

function buildGenerationFingerprint({
  siteIdentity,
  normalizedImage,
  context,
  userInfo,
  regenerate,
  anonymousContext
}) {
  return hashRequestFingerprint({
    site_hash: siteIdentity.siteHash || null,
    wp_install_uuid: siteIdentity.wpInstallUuid || null,
    user_id: userInfo.user_id || null,
    user_email: userInfo.user_email || null,
    anon_id: anonymousContext?.anonId || null,
    filename: normalizedImage.filename || null,
    url: normalizedImage.url || null,
    image_hash: normalizedImage.base64
      ? crypto.createHash('sha256').update(normalizedImage.base64).digest('hex')
      : null,
    context: context || {},
    regenerate: Boolean(regenerate)
  });
}

async function recordLegacyTrialUsage(supabase, payload) {
  const legacyPayload = {
    site_hash: payload.site_hash,
    site_fingerprint: payload.site_fingerprint,
    site_url: payload.site_url,
    prompt_tokens: payload.prompt_tokens,
    completion_tokens: payload.completion_tokens,
    total_tokens: payload.total_tokens,
    model_used: payload.model_used,
    generation_time_ms: payload.generation_time_ms,
    image_filename: payload.image_filename
  };
  let schemaMode = 'observability';

  let insertResult = await supabase.from('trial_usage').insert(payload);
  if (!insertResult.error) {
    logger.info('[usage] trial_usage_write', {
      table: 'trial_usage',
      success: true,
      schema_mode: schemaMode,
      site_hash: payload.site_hash || null,
      anon_id: payload.anon_id || null
    });
    logger.info('[altText] trial_usage insert succeeded', {
      operation: 'trial_usage_insert',
      schema_mode: 'observability',
      site_hash: payload.site_hash || null,
      site_url: payload.site_url || null,
      anon_id: payload.anon_id || null
    });
    return insertResult;
  }

  if (!isMissingSchemaError(insertResult.error)) {
    logger.error('[usage] trial_usage_write', {
      table: 'trial_usage',
      success: false,
      schema_mode: schemaMode,
      site_hash: payload.site_hash || null,
      anon_id: payload.anon_id || null,
      error: serializeSupabaseError(insertResult.error)
    });
    logger.error('[altText] trial_usage insert failed', {
      operation: 'trial_usage_insert',
      schema_mode: 'observability',
      site_hash: payload.site_hash || null,
      site_url: payload.site_url || null,
      anon_id: payload.anon_id || null,
      error: serializeSupabaseError(insertResult.error)
    });
    return insertResult;
  }

  logger.warn('[LEGACY_SCHEMA_FALLBACK] trial_usage observability columns unavailable; retrying legacy payload insert', {
    site_hash: payload.site_hash || null,
    site_url: payload.site_url || null,
    anon_id: payload.anon_id || null,
    error: serializeSupabaseError(insertResult.error)
  });

  schemaMode = 'legacy';
  insertResult = await supabase.from('trial_usage').insert(legacyPayload);
  if (insertResult.error) {
    logger.error('[usage] trial_usage_write', {
      table: 'trial_usage',
      success: false,
      schema_mode: schemaMode,
      site_hash: payload.site_hash || null,
      anon_id: payload.anon_id || null,
      error: serializeSupabaseError(insertResult.error)
    });
    logger.error('[altText] trial_usage insert failed', {
      operation: 'trial_usage_insert',
      schema_mode: 'legacy',
      site_hash: payload.site_hash || null,
      site_url: payload.site_url || null,
      anon_id: payload.anon_id || null,
      error: serializeSupabaseError(insertResult.error)
    });
  } else {
    logger.info('[usage] trial_usage_write', {
      table: 'trial_usage',
      success: true,
      schema_mode: schemaMode,
      site_hash: payload.site_hash || null,
      anon_id: payload.anon_id || null
    });
    logger.info('[altText] trial_usage insert succeeded', {
      operation: 'trial_usage_insert',
      schema_mode: 'legacy',
      site_hash: payload.site_hash || null,
      site_url: payload.site_url || null,
      anon_id: payload.anon_id || null
    });
  }

  return {
    ...insertResult,
    data: insertResult.data || null,
    table: 'trial_usage',
    schemaMode
  };
}

function buildAnonymousResponseFields(anonymousContext, trialInfo) {
  const resolvedTrialInfo = trialInfo || buildAnonymousTrialStatus({
    used: 0,
    limit: getAnonymousTrialLimit(),
    anonId: anonymousContext?.anonId || null
  });

  return {
    auth_state: resolvedTrialInfo.auth_state,
    quota_type: resolvedTrialInfo.quota_type,
    quota_state: resolvedTrialInfo.quota_state,
    credits_total: resolvedTrialInfo.credits_total,
    credits_used: resolvedTrialInfo.credits_used,
    credits_remaining: resolvedTrialInfo.credits_remaining,
    total_limit: resolvedTrialInfo.total_limit,
    limit: resolvedTrialInfo.limit,
    plan_type: resolvedTrialInfo.plan_type,
    anon_id: resolvedTrialInfo.anon_id || anonymousContext?.anonId || null,
    signup_required: Boolean(resolvedTrialInfo.signup_required),
    upgrade_required: Boolean(resolvedTrialInfo.upgrade_required),
    free_plan_offer: resolvedTrialInfo.free_plan_offer,
    warning_threshold: resolvedTrialInfo.warning_threshold,
    is_near_limit: resolvedTrialInfo.is_near_limit,
    trial_used: resolvedTrialInfo.trial_used,
    trial_remaining: resolvedTrialInfo.trial_remaining,
    trial_limit: resolvedTrialInfo.trial_limit,
    trial_exhausted: resolvedTrialInfo.trial_exhausted,
    anonymous: resolvedTrialInfo.anonymous
  };
}

function resolveQuotaPathLabel(reservation) {
  if (reservation?.reservation?.generation_request_id) {
    return 'V2 RPC';
  }
  if (reservation?.reservation?.quota_source === 'legacy_trial') {
    return 'legacy trial fallback';
  }
  if (reservation?.reservation?.quota_source === 'legacy') {
    return 'legacy license fallback';
  }
  return reservation?.reservation?.quota_source || 'unknown';
}

function logGenerationAccountingTrace({
  requestId,
  reservation,
  effectiveSite,
  effectiveLicenseKey,
  userInfo,
  usageWrite,
  trialWrite,
  finalizeResult,
  finalResultState
}) {
  const payload = {
    request_id: requestId || null,
    final_result_state: finalResultState,
    user_id: userInfo?.user_id || null,
    user_email: userInfo?.user_email || null,
    license_key_prefix: effectiveLicenseKey ? `${effectiveLicenseKey.substring(0, 8)}...` : null,
    site_id: effectiveSite?.id || reservation?.site?.id || null,
    site_hash: effectiveSite?.site_hash || reservation?.site?.site_hash || null,
    quota_path: resolveQuotaPathLabel(reservation),
    quota_source: reservation?.reservation?.quota_source || null,
    generation_request_id: reservation?.reservation?.generation_request_id || null,
    generation_requests_used: Boolean(reservation?.reservation?.generation_request_id),
    usage_events_used: Boolean(reservation?.reservation?.generation_request_id),
    usage_logs_write_succeeded: usageWrite ? !usageWrite.error : null,
    trial_usage_write_succeeded: trialWrite ? !trialWrite.error : null,
    usage_logs_write_error: usageWrite?.error ? serializeSupabaseError(usageWrite.error) : null,
    trial_usage_write_error: trialWrite?.error ? serializeSupabaseError(trialWrite.error) : null,
    quota_summaries_should_have_updated: Boolean(usageWrite?.quota_summary_expected),
    generation_requests_final_status: finalizeResult?.data?.status || null,
    generation_finalize_error: finalizeResult?.error ? serializeSupabaseError(finalizeResult.error) : null
  };

  const hasFailure = Boolean(
    payload.usage_logs_write_error
    || payload.trial_usage_write_error
    || payload.generation_finalize_error
    || finalResultState !== 'succeeded'
  );
  logger[hasFailure ? 'warn' : 'info']('[usage] generation_accounting_trace', payload);
}

const requestSchema = z.object({
  image: z
    .object({
      base64: z.string().optional(),
      image_base64: z.string().optional(),
      url: z.string().url().optional(),
      width: z.number().optional(),
      height: z.number().optional(),
      mime_type: z.string().optional(),
      filename: z.string().optional()
    })
    .refine(
      data => Boolean(data.base64 || data.image_base64 || data.url),
      'Send base64/image_base64 or url.'
    ),
  context: z
    .object({
      title: z.string().optional(),
      caption: z.string().optional(),
      pageTitle: z.string().optional(),
      altTextSuggestion: z.string().optional()
    })
    .optional(),
  trial_batch: z
    .object({
      requested_total: z.number().int().positive().max(500).optional()
    })
    .optional()
});

function createAltTextRouter({
  supabase,
  redis,
  resultCache,
  checkRateLimit,
  getSiteFromHeaders
}) {
  const router = express.Router();

  router.post('/', async (req, res) => {
    const parsed = requestSchema.safeParse(req.body);
    if (!parsed.success) {
      logger.error('[altText] Schema validation failed', {
        errors: parsed.error.flatten(),
        bodyPreview: JSON.stringify(req.body).substring(0, 500)
      });
      return res.status(400).json({ 
        error: 'INVALID_REQUEST', 
        message: 'Invalid payload - request does not match expected schema',
        details: parsed.error.flatten() 
      });
    }

    const { image, context = {} } = parsed.data;
    const hasAccountAuth = Boolean(
      req.user
      || req.license
      || req.header('X-License-Key')
    );
    const siteIdentity = buildSiteIdentity({
      siteHash: req.trialMode ? req.trialSiteHash : (req.header('X-Site-Key') || req.header('X-Site-Hash') || 'default'),
      installUuid: req.trialMode ? req.trialSiteHash : (req.header('X-Site-Key') || req.header('X-Site-Hash') || req.body?.site_id || req.body?.siteId || null),
      siteUrl: req.header('X-Site-URL') || req.body?.trial_site_url || req.body?.site_url || null,
      siteFingerprint: req.header('X-Site-Fingerprint') || req.body?.site_fingerprint || null,
      // Trial mode is explicitly intended to work for local/dev installs.
      // For authenticated accounts, allow dev installs for testing; quota is still
      // enforced by license key / JWT and does not grant anonymous access.
      allowDevelopment: Boolean(req.trialMode || hasAccountAuth)
    });
    const anonymousContext = buildAnonymousContext({
      req,
      body: parsed.data,
      siteIdentity
    });

    if (req.trialMode) {
      logger.info('[altText] Anonymous identity resolved', {
        site_hash: siteIdentity.siteHash,
        anon_id: anonymousContext.anonId || null,
        anon_id_source: anonymousContext.source || null,
        risk_key: anonymousContext.riskKey || null,
        site_url: siteIdentity.siteUrl || null,
        site_fingerprint: siteIdentity.siteFingerprint ? 'present' : 'absent'
      });
    }

    logger.info('[altText] Request received', {
      mode: req.trialMode ? 'trial' : (req.authMethod || 'unknown'),
      site_hash: req.trialMode ? req.trialSiteHash : (req.header('X-Site-Key') || req.header('X-Site-Hash') || null),
      site_fingerprint: req.header('X-Site-Fingerprint') ? 'present' : 'absent',
      site_url: req.header('X-Site-URL') || null,
      hasImage: !!(parsed.data?.image),
      hasBase64: !!(parsed.data?.image?.base64 || parsed.data?.image?.image_base64),
      hasUrl: !!parsed.data?.image?.url,
      hasContext: !!parsed.data?.context,
      plugin_version: req.header('X-Plugin-Version') || null,
      anon_id: anonymousContext.anonId || null,
      anonymous_risk_key: anonymousContext.riskKey || null
    });

    if (siteIdentity.error === 'DEVELOPMENT_SITE_NOT_ALLOWED') {
      logger.warn('[altText] Request rejected: development site not allowed', {
        site_hash: siteIdentity.siteHash || null,
        site_url: siteIdentity.siteUrl || null,
        request_id: req.id || null,
        mode: req.trialMode ? 'trial' : (req.authMethod || 'unknown')
      });
      return res.status(403).json({
        error: 'DEVELOPMENT_SITE_NOT_ALLOWED',
        code: 'DEVELOPMENT_SITE_NOT_ALLOWED',
        message: 'Development and localhost sites cannot claim production quota.'
      });
    }
    const siteKey = siteIdentity.siteHash || 'default';
    // Get license key from header OR from JWT-authenticated user
    const licenseKey = req.header('X-License-Key') || req.license?.license_key;
    const userInfo = extractUserInfo(req);
    // Support regenerate flag in body or query, plus cache bypass headers
    const regenerate = req.body.regenerate === true || req.query.regenerate === 'true' || req.query.regenerate === '1';
    const bypassCache = regenerate || req.header('X-Bypass-Cache') === 'true' || req.query.no_cache === '1';
    const rateLimitKey = req.trialMode
      ? `${siteKey}:${anonymousContext.riskKey || anonymousContext.anonId || 'anonymous'}:${req.ip || 'unknown-ip'}`
      : `${siteKey}:${req.ip || 'unknown-ip'}`;

    // Rate limit per site/license
    if (!(await checkRateLimit(rateLimitKey))) {
      logger.warn('[altText] Request rejected: rate limit exceeded', {
        site_hash: siteIdentity.siteHash || null,
        anon_id: anonymousContext.anonId || null,
        request_id: req.id || null,
        mode: req.trialMode ? 'trial' : (req.authMethod || 'unknown')
      });
      return res.status(429).json({
        error: 'RATE_LIMIT_EXCEEDED',
        message: 'Rate limit exceeded for this site. Please retry later.',
        code: 'RATE_LIMIT_EXCEEDED'
      });
    }

    // Validate and normalize image payload FIRST to get clean base64
    const { errors, warnings, normalized } = validateImagePayload(image);
    if (errors.length) {
      logger.error('[altText] Image validation failed', {
        errors,
        warnings,
        imageKeys: Object.keys(image),
        hasBase64: !!(image.base64 || image.image_base64),
        base64Length: (image.base64 || image.image_base64 || '').length,
        hasUrl: !!image.url,
        width: image.width,
        height: image.height
      });
      return res.status(400).json({ 
        error: 'INVALID_REQUEST', 
        message: 'Image validation failed',
        errors, 
        warnings 
      });
    }
    
    // Log warnings if any
    if (warnings.length) {
      logger.warn('[altText] Image validation warnings', { warnings });
    }

    // Generate cache key from NORMALIZED base64 (after stripping data URL prefix)
    // This ensures cache consistency even if frontend sends data URLs vs raw base64
    const normalizedBase64 = normalized.base64 || '';
    const cacheKey = normalizedBase64 ? hashPayload(normalizedBase64) : null;

    logger.info('[altText] Image details', {
      imageSource: normalizedBase64 ? 'base64' : (normalized.url ? 'url' : 'none'),
      normalizedBase64Length: normalizedBase64 ? normalizedBase64.length : 0,
      imageUrl: normalized.url || null,
      dimensions: normalized.width && normalized.height ? `${normalized.width}x${normalized.height}` : 'unknown',
      filename: normalized.filename || 'unknown',
      cacheKey: cacheKey ? cacheKey.substring(0, 16) + '...' : null,
      bypassCache,
      regenerate,
      warnings: warnings.length
    });
    
    if (cacheKey && !bypassCache) {
      let cachedData = null;

      if (redis) {
        try {
          const cached = await redis.get(`alttext:cache:${cacheKey}`);
          if (cached) {
            cachedData = JSON.parse(cached);
          }
        } catch (e) {
          // ignore cache errors
        }
      } else if (resultCache.has(cacheKey)) {
        cachedData = resultCache.get(cacheKey);
      }

      if (cachedData) {
        logger.info('[altText] Cache hit - returning cached result', {
          cacheKey: cacheKey ? cacheKey.substring(0, 16) + '...' : null,
          cachedAltText: cachedData.altText,
          cachedModel: cachedData.meta?.modelUsed
        });

        // Fetch current quota status to include accurate credits in cached response
        // This ensures the plugin gets up-to-date usage info even from cache
        let creditsInfo = {};
        let trialInfo = null;
        let anonymousResponseFields = null;
        try {
          const quotaStatus = await getQuotaStatus(supabase, {
            account: req.user || req.license || null,
            licenseKey,
            siteIdentity,
            requestId: req.id || null
          });
          if (req.trialMode) {
            trialInfo = await getAnonymousTrialStatus(supabase, {
              quotaStatus: quotaStatus.error ? {} : quotaStatus,
              siteHash: req.trialSiteHash || siteIdentity.siteHash,
              anonId: anonymousContext.anonId
            });
            anonymousResponseFields = buildAnonymousResponseFields(anonymousContext, trialInfo);
          }
          if (!quotaStatus.error) {
            creditsInfo = {
              credits_used: quotaStatus.credits_used,
              credits_remaining: quotaStatus.credits_remaining,
              credits_total: quotaStatus.total_limit,
              total_limit: quotaStatus.total_limit,
              limit: quotaStatus.total_limit
            };
            logger.info('[altText] Quota status fetched for cached response', creditsInfo);
          }
        } catch (err) {
          logger.warn('[altText] Failed to fetch quota for cached response', { error: err.message });
        }

        if (req.trialMode && !anonymousResponseFields) {
          anonymousResponseFields = buildAnonymousResponseFields(anonymousContext, null);
        }

        const cachedTrialGeneration = req.trialMode && anonymousResponseFields
          ? buildTrialGenerationForSingleRequest({
            outcome: 'cached_hit',
            batchRequestedTotal: parsed.data.trial_batch?.requested_total,
            trialLimit: anonymousResponseFields.trial_limit,
            trialUsedBefore: anonymousResponseFields.trial_used,
            trialRemainingBefore: anonymousResponseFields.trial_remaining,
            trialUsedAfter: anonymousResponseFields.trial_used,
            trialRemainingAfter: anonymousResponseFields.trial_remaining
          })
          : null;

        return res.json({
          success: true,
          ...cachedData,
          ...creditsInfo,
          ...(trialInfo || {}),
          ...(anonymousResponseFields || {}),
          ...(cachedTrialGeneration ? { trial_generation: cachedTrialGeneration } : {}),
          cached: true
        });
      }
    } else if (bypassCache) {
      logger.info('[altText] Cache bypassed', { reason: regenerate ? 'regenerate flag' : 'explicit bypass' });
    }

    if (req.trialMode) {
      try {
        const trialSiteResult = await findOrCreateTrialSite(supabase, {
          siteHash: siteIdentity.siteHash,
          siteUrl: siteIdentity.siteUrl,
          fingerprint: siteIdentity.siteFingerprint
        });
        if (trialSiteResult.error) {
          logger.error('[altText] Trial site creation/lookup failed', {
            error: trialSiteResult.error.message || trialSiteResult.error,
            site_hash: siteIdentity.siteHash,
            site_url: siteIdentity.siteUrl || null,
            anon_id: anonymousContext.anonId || null
          });
        } else {
          logger.info('[altText] Anonymous trial site resolved', {
            site_id: trialSiteResult.data?.id || null,
            site_hash: trialSiteResult.data?.site_hash || siteIdentity.siteHash,
            anon_id: anonymousContext.anonId || null
          });
        }
      } catch (err) {
        logger.error('[altText] Trial site upsert threw unexpectedly', {
          error: err.message,
          site_hash: siteIdentity.siteHash,
          anon_id: anonymousContext.anonId || null
        });
      }
    }

    const idempotencyKey = extractIdempotencyKey(req);
    const requestFingerprint = buildGenerationFingerprint({
      siteIdentity,
      normalizedImage: normalized,
      context,
      userInfo,
      regenerate,
      anonymousContext
    });

    const quotaMetadata = {
      request_id: req.id || null,
      endpoint: 'api/alt-text',
      image_filename: normalized.filename || null,
      image_url: normalized.url || null,
      plugin_version: userInfo.plugin_version || null,
      wp_user_id: userInfo.user_id || null,
      wp_user_email: userInfo.user_email || null,
      anon_id: anonymousContext.anonId || null,
      anonymous_risk_key: anonymousContext.riskKey || null,
      anonymous_ip_hash: anonymousContext.ipHash || null,
      anonymous_identity_source: anonymousContext.source || null
    };

    let trialAtRequestStart = null;
    if (req.trialMode) {
      logger.info('[altText] Anonymous quota check', {
        site_hash: siteIdentity.siteHash,
        anon_id: anonymousContext.anonId || null,
        risk_key: anonymousContext.riskKey || null,
        request_id: req.id || null
      });

      const quotaStatusBefore = await getQuotaStatus(supabase, {
        account: req.user || req.license || null,
        licenseKey,
        siteIdentity,
        requestId: req.id || null
      });
      trialAtRequestStart =
        (await getAnonymousTrialStatus(supabase, {
          quotaStatus: quotaStatusBefore.error ? {} : quotaStatusBefore,
          siteHash: req.trialSiteHash || siteIdentity.siteHash,
          anonId: anonymousContext.anonId
        }))
        || buildAnonymousTrialStatus({
          used: 0,
          limit: getAnonymousTrialLimit(),
          anonId: anonymousContext.anonId
        });

      logger.info('[altText] trial_quota_checkpoint', {
        site_hash: siteIdentity.siteHash,
        anon_id: anonymousContext.anonId || null,
        requested_count: 1,
        processable_count: trialAtRequestStart.trial_remaining > 0 ? 1 : 0,
        trial_used_before: trialAtRequestStart.trial_used,
        trial_remaining_before: trialAtRequestStart.trial_remaining,
        trial_limit: trialAtRequestStart.trial_limit,
        batch_requested_total: parsed.data.trial_batch?.requested_total ?? null
      });
    }

    const reservation = await reserveGenerationQuota(supabase, {
      account: req.user || req.license || null,
      licenseKey,
      siteIdentity,
      creditsNeeded: 1,
      // Anonymous dashboard usage burns the site-level trial bucket only.
      // Authenticated free users continue to use the monthly free-plan quota.
      quotaMode: req.trialMode ? 'trial' : 'site',
      idempotencyKey,
      requestFingerprint,
      requestMetadata: quotaMetadata,
      requestId: req.id || null
    });

    // When V2 quota fell back to legacy_trial, enforce the trial limit
    // from the trial_usage table since no RPC guard ran.
    if (!reservation.error && req.trialMode && reservation.reservation?.quota_source === 'legacy_trial') {
      const trialInfo = await getAnonymousTrialStatus(supabase, {
        quotaStatus: {},
        siteHash: siteIdentity.siteHash || req.trialSiteHash,
        anonId: anonymousContext.anonId
      });
      if (trialInfo?.trial_exhausted) {
        const anonymousResponseFields = buildAnonymousResponseFields(anonymousContext, trialInfo);
        logger.warn('[altText] Request rejected: anonymous trial exhausted during legacy fallback', {
          site_hash: siteIdentity.siteHash,
          anon_id: anonymousContext.anonId || null,
          quota_source: reservation.reservation?.quota_source || null,
          credits_used: anonymousResponseFields.credits_used,
          credits_total: anonymousResponseFields.credits_total,
          quota_state: anonymousResponseFields.quota_state
        });
        return res.status(402).json({
          error: 'TRIAL_EXHAUSTED',
          code: 'TRIAL_EXHAUSTED',
          message: 'Free trial exhausted. Upgrade to continue generating alt text.',
          ...trialInfo,
          ...anonymousResponseFields,
          trial_generation: buildTrialGenerationForSingleRequest({
            outcome: 'quota_denied',
            batchRequestedTotal: parsed.data.trial_batch?.requested_total,
            trialLimit: anonymousResponseFields.trial_limit,
            trialUsedBefore: anonymousResponseFields.trial_used,
            trialRemainingBefore: anonymousResponseFields.trial_remaining,
            trialUsedAfter: anonymousResponseFields.trial_used,
            trialRemainingAfter: anonymousResponseFields.trial_remaining
          })
        });
      }
    }

    if (!reservation.error && req.trialMode) {
      logger.info('[altText] Anonymous quota granted', {
        site_hash: siteIdentity.siteHash,
        anon_id: anonymousContext.anonId || null,
        quota_source: reservation.reservation?.quota_source || null,
        generation_request_id: reservation.reservation?.generation_request_id || null
      });
    }

    if (reservation.error) {
      // Trial exhausted must return structured trial status for UI correctness.
      let trialInfo = null;
      let anonymousResponseFields = null;
      if (req.trialMode) {
        try {
          const quotaStatus = await getQuotaStatus(supabase, {
            account: req.user || req.license || null,
            licenseKey,
            siteIdentity,
            requestId: req.id || null
          });
          trialInfo = await getAnonymousTrialStatus(supabase, {
            quotaStatus: quotaStatus.error ? {} : quotaStatus,
            siteHash: req.trialSiteHash || siteIdentity.siteHash,
            anonId: anonymousContext.anonId
          });
          anonymousResponseFields = buildAnonymousResponseFields(anonymousContext, trialInfo);
        } catch (_err) {
          // Best-effort: do not block error response.
        }

        if (!anonymousResponseFields) {
          anonymousResponseFields = buildAnonymousResponseFields(anonymousContext, null);
        }
      }

      if (req.trialMode) {
        logger.warn('[altText] Request rejected: anonymous quota denied', {
          site_hash: siteIdentity.siteHash,
          anon_id: anonymousContext.anonId || null,
          code: reservation.error,
          credits_used: anonymousResponseFields?.credits_used ?? null,
          credits_total: anonymousResponseFields?.credits_total ?? null,
          quota_state: anonymousResponseFields?.quota_state ?? null,
          trial_exhausted: anonymousResponseFields?.trial_exhausted === true
        });
      }

      if (!req.trialMode) {
        logger.warn('[altText] Request rejected: quota denied', {
          site_hash: siteIdentity.siteHash || null,
          request_id: req.id || null,
          code: reservation.error,
          message: reservation.message || null,
          auth_method: req.authMethod || null,
          license_key_prefix: licenseKey ? `${licenseKey.substring(0, 8)}...` : null
        });
      }

      const trialGenerationDenied = req.trialMode && trialAtRequestStart
        ? buildTrialGenerationForSingleRequest({
          outcome: 'quota_denied',
          batchRequestedTotal: parsed.data.trial_batch?.requested_total,
          trialLimit: trialAtRequestStart.trial_limit,
          trialUsedBefore: trialAtRequestStart.trial_used,
          trialRemainingBefore: trialAtRequestStart.trial_remaining,
          trialUsedAfter: anonymousResponseFields?.trial_used ?? trialAtRequestStart.trial_used,
          trialRemainingAfter: anonymousResponseFields?.trial_remaining ?? trialAtRequestStart.trial_remaining
        })
        : null;

      if (req.trialMode && trialGenerationDenied) {
        logger.info('[altText] trial_generation_quota_denied', {
          site_hash: siteIdentity.siteHash,
          anon_id: anonymousContext.anonId || null,
          skipped_due_to_limit: trialGenerationDenied.skipped_due_to_limit,
          trial_used_before: trialGenerationDenied.trial_used_before,
          trial_limit: trialGenerationDenied.trial_limit,
          processed_count: trialGenerationDenied.processed_count
        });
      }

      logGenerationAccountingTrace({
        requestId: req.id || null,
        reservation,
        effectiveSite: reservation.site || null,
        effectiveLicenseKey: licenseKey,
        userInfo,
        usageWrite: null,
        trialWrite: null,
        finalizeResult: null,
        finalResultState: 'quota_denied'
      });

      return res.status(reservation.status || 402).json({
        error: reservation.error,
        message: reservation.message || 'Quota exceeded',
        code: reservation.error,
        credits_used: anonymousResponseFields?.credits_used ?? reservation.payload?.credits_used,
        credits_remaining: anonymousResponseFields?.credits_remaining ?? reservation.payload?.remaining_credits,
        credits_total: anonymousResponseFields?.credits_total ?? reservation.payload?.total_limit,
        total_limit: anonymousResponseFields?.credits_total ?? reservation.payload?.total_limit,
        reset_date: reservation.payload?.quota_period_end || reservation.payload?.reset_date,
        remaining: anonymousResponseFields?.credits_remaining ?? reservation.payload?.remaining_credits,
        ...(trialInfo || {}),
        ...(anonymousResponseFields || {}),
        trial_exhausted: anonymousResponseFields?.trial_exhausted === true || reservation.error === 'TRIAL_EXHAUSTED' ? true : undefined,
        ...(trialGenerationDenied ? { trial_generation: trialGenerationDenied } : {})
      });
    }

    logger.info('[altText] Quota reserved, calling OpenAI', {
      mode: req.trialMode ? 'trial' : 'site',
      quota_source: reservation.reservation?.quota_source || 'unknown',
      site_hash: siteIdentity.siteHash,
      generation_request_id: reservation.reservation?.generation_request_id || null
    });
    const startTime = Date.now();
    let altText;
    let usage;
    let meta;
    let generationTime = 0;

    try {
      const generationResult = await generateAltText({
        image: normalized,
        context: { ...context, filename: normalized.filename }
      });
      altText = generationResult.altText;
      usage = generationResult.usage;
      meta = generationResult.meta;
      generationTime = Date.now() - startTime;
    } catch (error) {
      const finalizeResult = await finalizeGenerationQuotaReservation(supabase, {
        generationRequestId: reservation.reservation?.generation_request_id || null,
        success: false,
        finalMetadata: {
          error_message: error.message,
          error_code: error.code || 'GENERATION_FAILED',
          request_id: req.id || null
        }
      });

      const errorCode = error.code || 'GENERATION_FAILED';
      const isRetryable = error.isRetryable === true;
      const httpStatus = errorCode === 'BACKEND_CONFIG_ERROR' ? 502
        : errorCode === 'UPSTREAM_RATE_LIMITED' ? 503
        : errorCode === 'UPSTREAM_GENERATION_ERROR' ? 502
        : 500;

      logger.error('[altText] Alt text generation failed', {
        error: error.message,
        code: errorCode,
        isRetryable,
        trialMode: !!req.trialMode,
        requestId: req.id || null,
        siteHash: siteKey,
        generation_request_id: reservation.reservation?.generation_request_id || null,
        quota_source: reservation.reservation?.quota_source || null,
        anon_id: anonymousContext.anonId || null
      });

      logGenerationAccountingTrace({
        requestId: req.id || null,
        reservation,
        effectiveSite: reservation.site || null,
        effectiveLicenseKey: licenseKey,
        userInfo,
        usageWrite: null,
        trialWrite: null,
        finalizeResult,
        finalResultState: 'generation_failed'
      });

      // Build trial info even on failure so the plugin knows remaining credits
      let trialInfo = null;
      let anonymousResponseFields = null;
      if (req.trialMode) {
        try {
          trialInfo = await getAnonymousTrialStatus(supabase, {
            quotaStatus: {},
            siteHash: req.trialSiteHash || siteIdentity.siteHash,
            anonId: anonymousContext.anonId
          });
          anonymousResponseFields = buildAnonymousResponseFields(anonymousContext, trialInfo);
        } catch (_e) { /* best effort */ }

        if (!anonymousResponseFields) {
          anonymousResponseFields = buildAnonymousResponseFields(anonymousContext, null);
        }
      }

      const trialGenerationFailed = req.trialMode && trialAtRequestStart && anonymousResponseFields
        ? buildTrialGenerationForSingleRequest({
          outcome: 'generation_failed',
          batchRequestedTotal: parsed.data.trial_batch?.requested_total,
          trialLimit: anonymousResponseFields.trial_limit,
          trialUsedBefore: trialAtRequestStart.trial_used,
          trialRemainingBefore: trialAtRequestStart.trial_remaining,
          trialUsedAfter: anonymousResponseFields.trial_used,
          trialRemainingAfter: anonymousResponseFields.trial_remaining
        })
        : null;

      return res.status(httpStatus).json({
        error: errorCode,
        code: errorCode,
        message: errorCode === 'BACKEND_CONFIG_ERROR'
          ? 'The alt text service is temporarily misconfigured. Please try again later.'
          : isRetryable
            ? 'Alt text generation temporarily unavailable. Please retry.'
            : 'Failed to generate alt text.',
        retryable: isRetryable,
        ...(trialInfo || {}),
        ...(anonymousResponseFields || {}),
        ...(trialGenerationFailed ? { trial_generation: trialGenerationFailed } : {})
      });
    }
    
    logger.info('[altText] Alt text generated', {
      altText,
      altTextLength: altText ? altText.length : 0,
      generationTimeMs: generationTime,
      modelUsed: meta?.modelUsed,
      tokensUsed: usage?.total_tokens
    });

    const finalizeResult = await finalizeGenerationQuotaReservation(supabase, {
      generationRequestId: reservation.reservation?.generation_request_id || null,
      success: true,
      finalMetadata: {
        request_id: req.id || null,
        cached: false,
        model_used: meta?.modelUsed || null,
        total_tokens: usage?.total_tokens || null
      }
    });

    // Record usage/credits
    let usageResult = { error: null };
    const effectiveSite = reservation.site || null;
    const effectiveLicenseKey = effectiveSite?.license_key || licenseKey || null;

    if (req.trialMode) {
      // Trial mode: insert into trial_usage table (no foreign key constraints).
      const trialPayload = {
        site_hash: siteIdentity.siteHash || req.trialSiteHash,
        site_fingerprint: siteIdentity.siteFingerprint || req.header('X-Site-Fingerprint') || null,
        site_url: siteIdentity.siteUrl || req.header('X-Site-URL') || null,
        anon_id: anonymousContext.anonId || null,
        anonymous_risk_key: anonymousContext.riskKey || null,
        ip_hash: anonymousContext.ipHash || null,
        prompt_tokens: usage?.prompt_tokens || null,
        completion_tokens: usage?.completion_tokens || null,
        total_tokens: usage?.total_tokens || null,
        model_used: meta?.modelUsed || null,
        generation_time_ms: meta?.generation_time_ms || null,
        image_filename: normalized.filename || null
      };
      logger.info('[altText] Recording anonymous trial usage', {
        site_hash: trialPayload.site_hash,
        anon_id: anonymousContext.anonId || null,
        risk_key: anonymousContext.riskKey || null
      });
      const { error } = await recordLegacyTrialUsage(supabase, trialPayload);
      if (error) {
        logger.error('[altText] Failed to record anonymous trial usage', {
          site_hash: trialPayload.site_hash,
          anon_id: anonymousContext.anonId || null,
          error: serializeSupabaseError(error)
        });
      }
      usageResult = { error };
    } else {
      // Normal flow: record in usage_logs with license tracking.
      let licenseId = null;
      if (effectiveLicenseKey) {
        try {
          const { data: licenseData } = await supabase
            .from('licenses')
            .select('id')
            .eq('license_key', effectiveLicenseKey)
            .maybeSingle();
          licenseId = licenseData?.id || null;
        } catch (err) {
          logger.warn('[altText] Failed to look up license_id', { error: err.message });
        }
      }

      logger.info('[altText] Recording usage', {
        licenseKey: effectiveLicenseKey ? `${effectiveLicenseKey.substring(0, 8)}...` : 'missing',
        licenseId: licenseId ? `${licenseId.substring(0, 8)}...` : 'missing',
        siteKey: effectiveSite?.site_hash || siteKey,
        userId: userInfo.user_id,
        creditsUsed: 1
      });

      usageResult = await recordUsage(supabase, {
        licenseKey: effectiveLicenseKey,
        licenseId,
        siteHash: effectiveSite?.site_hash || siteKey,
        userId: userInfo.user_id,
        userEmail: userInfo.user_email,
        pluginVersion: userInfo.plugin_version,
        creditsUsed: 1,
        promptTokens: usage?.prompt_tokens,
        completionTokens: usage?.completion_tokens,
        totalTokens: usage?.total_tokens,
        cached: false,
        modelUsed: meta?.modelUsed,
        generationTimeMs: meta?.generation_time_ms,
        imageUrl: normalized.url,
        imageFilename: normalized.filename,
        endpoint: 'api/alt-text',
        status: 'success'
      });

      if (licenseId) {
        try {
          const licenseUpdate = supabase
            .from('licenses')
            .update({ last_generation_at: new Date().toISOString(), reengagement_sent: false })
            .eq('id', licenseId);
          if (licenseUpdate && typeof licenseUpdate.then === 'function') {
            await licenseUpdate;
          }
        } catch (_error) {
          // Best-effort lifecycle touch.
        }
      }
    }
    
    if (usageResult.error) {
      logger.error('[altText] Failed to record usage', {
        site_hash: effectiveSite?.site_hash || siteKey || null,
        request_id: req.id || null,
        error: serializeSupabaseError(usageResult.error)
      });
    } else {
      logger.info('[altText] Usage recorded successfully', {
        site_hash: effectiveSite?.site_hash || siteKey || null,
        request_id: req.id || null,
        mode: req.trialMode ? 'trial' : 'site'
      });
    }

    if (effectiveSite?.id) {
      await upsertGeneratedImageAltState(supabase, {
        siteId: effectiveSite.id,
        image: normalized,
        context,
        altText,
        requestId: req.id || null,
        generationRequestId: reservation.reservation?.generation_request_id || null
      });
    } else {
      logger.warn('[image-state] ledger_write_skipped', {
        site_id: null,
        site_hash: effectiveSite?.site_hash || siteKey || null,
        request_id: req.id || null,
        error: 'SITE_ID_UNAVAILABLE_AFTER_GENERATION'
      });
    }

    logGenerationAccountingTrace({
      requestId: req.id || null,
      reservation,
      effectiveSite,
      effectiveLicenseKey,
      userInfo,
      usageWrite: req.trialMode ? null : usageResult,
      trialWrite: req.trialMode ? usageResult : null,
      finalizeResult,
      finalResultState: 'succeeded'
    });

    // Get updated quota status to return accurate credits_remaining
    let creditsRemaining = null;
    let totalLimit = null;
    let creditsUsed = 1;
    let trialInfo = null;
    let anonymousResponseFields = null;
    await new Promise(resolve => setTimeout(resolve, 50));

    const quotaStatus = await getQuotaStatus(supabase, {
      account: req.user || req.license || null,
      licenseKey: effectiveLicenseKey,
      siteIdentity,
      requestId: req.id || null
    });

    if (!quotaStatus.error) {
      creditsRemaining = quotaStatus.credits_remaining;
      totalLimit = quotaStatus.total_limit;
      creditsUsed = quotaStatus.credits_used;
      logger.info('[altText] Quota status fetched after usage', {
        credits_remaining: creditsRemaining,
        total_limit: totalLimit,
        credits_used: creditsUsed,
        licenseKey: effectiveLicenseKey ? `${effectiveLicenseKey.substring(0, 8)}...` : 'missing',
        siteKey: effectiveSite?.site_hash || siteKey
      });
    } else if (reservation.reservation) {
      creditsRemaining = reservation.reservation.remaining_credits ?? creditsRemaining;
      totalLimit = reservation.reservation.total_limit ?? totalLimit;
      creditsUsed = reservation.reservation.credits_used ?? creditsUsed;
      logger.warn('[altText] Falling back to reservation quota snapshot', {
        error: quotaStatus.error,
        credits_remaining: creditsRemaining,
        total_limit: totalLimit,
        credits_used: creditsUsed
      });
    }

    // Trial mode should always return authoritative trial counters, even when
    // quota status fails (eg. dev hosts or no V2 schema).
    if (req.trialMode) {
      try {
        trialInfo = await getAnonymousTrialStatus(supabase, {
          quotaStatus: quotaStatus && !quotaStatus.error ? quotaStatus : {},
          siteHash: req.trialSiteHash || siteIdentity.siteHash,
          anonId: anonymousContext.anonId
        });
        anonymousResponseFields = buildAnonymousResponseFields(anonymousContext, trialInfo);
      } catch (_err) {
        // Best-effort: never block successful generation response.
      }

      if (!anonymousResponseFields) {
        anonymousResponseFields = buildAnonymousResponseFields(anonymousContext, null);
      }
    }

    if (anonymousResponseFields) {
      creditsRemaining = anonymousResponseFields.credits_remaining;
      totalLimit = anonymousResponseFields.credits_total;
      creditsUsed = anonymousResponseFields.credits_used;
    }

    if (cacheKey && !bypassCache) {
      const payload = { altText, warnings, usage, meta };
      if (redis) {
        redis.set(`alttext:cache:${cacheKey}`, JSON.stringify(payload), 'EX', 60 * 60 * 24 * 7).catch(() => {});
      } else {
        resultCache.set(cacheKey, payload);
      }
    }

    const response = {
      success: true,
      altText,
      credits_used: creditsUsed,
      credits_remaining: creditsRemaining !== null ? creditsRemaining : undefined,
      credits_total: totalLimit !== null ? totalLimit : undefined,
      total_limit: totalLimit !== null ? totalLimit : undefined,
      limit: totalLimit !== null ? totalLimit : undefined,
      ...(trialInfo || {}),
      ...(anonymousResponseFields || {}),
      usage: {
        prompt_tokens: usage?.prompt_tokens,
        completion_tokens: usage?.completion_tokens,
        total_tokens: usage?.total_tokens
      },
      meta: {
        modelUsed: meta?.modelUsed,
        cached: false,
        generation_time_ms: meta?.generation_time_ms
      }
    };

    if (req.trialMode && trialAtRequestStart && anonymousResponseFields) {
      response.trial_generation = buildTrialGenerationForSingleRequest({
        outcome: 'success',
        batchRequestedTotal: parsed.data.trial_batch?.requested_total,
        trialLimit: anonymousResponseFields.trial_limit,
        trialUsedBefore: trialAtRequestStart.trial_used,
        trialRemainingBefore: trialAtRequestStart.trial_remaining,
        trialUsedAfter: anonymousResponseFields.trial_used,
        trialRemainingAfter: anonymousResponseFields.trial_remaining
      });
      logger.info('[altText] trial_generation_success', {
        processed_count: response.trial_generation.processed_count,
        skipped_due_to_limit: response.trial_generation.skipped_due_to_limit,
        trial_used_before: response.trial_generation.trial_used_before,
        trial_used_after: response.trial_generation.trial_used_after,
        trial_limit: response.trial_generation.trial_limit
      });
    }

    // Log the response being sent
    logger.info('[altText] Sending response', {
      mode: req.trialMode ? 'trial' : 'site',
      success: true,
      has_altText: !!response.altText,
      credits_used: response.credits_used,
      credits_remaining: response.credits_remaining,
      limit: response.limit,
      trial_used: response.trial_used ?? null,
      trial_remaining: response.trial_remaining ?? null,
      trial_exhausted: response.trial_exhausted ?? null,
      signup_required: response.signup_required ?? null,
      anon_id: anonymousContext.anonId || null,
      site_hash: siteIdentity.siteHash,
      quota_source: reservation.reservation?.quota_source || 'unknown'
    });

    if (req.trialMode && response.signup_required !== undefined) {
      logger.info('[altText] Anonymous signup_required state returned', {
        site_hash: siteIdentity.siteHash,
        anon_id: anonymousContext.anonId || null,
        signup_required: response.signup_required,
        quota_state: response.quota_state || null,
        free_plan_offer: response.free_plan_offer || null
      });
    }
    
    res.json(response);
  });

  // Admin endpoint to flush alt text cache
  router.post('/flush-cache', async (req, res) => {
    const logger = require('../lib/logger');
    const adminKey = req.header('X-Admin-Key');

    if (!hasValidAdminKey(adminKey)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    try {
      let flushed = 0;

      if (redis) {
        // Get all alttext cache keys and delete them
        const keys = await redis.keys('alttext:cache:*');
        if (keys.length > 0) {
          await redis.del(...keys);
          flushed = keys.length;
        }
        logger.info('[altText] Redis cache flushed', { keysDeleted: flushed });
      } else {
        // Clear in-memory cache
        resultCache.clear();
        flushed = resultCache.size;
        logger.info('[altText] In-memory cache flushed');
      }

      res.json({
        success: true,
        message: `Cache flushed successfully`,
        keysDeleted: flushed
      });
    } catch (err) {
      logger.error('[altText] Failed to flush cache', { error: err.message });
      res.status(500).json({ error: 'Failed to flush cache', message: err.message });
    }
  });

  return router;
}

module.exports = { createAltTextRouter };
