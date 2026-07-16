const express = require('express');
const crypto = require('crypto');
const { z } = require('zod');
const logger = require('../lib/logger');
const { captureServerEvent } = require('../lib/posthog');
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
const { buildSiteIdentity, normalizeDomain } = require('../lib/siteIdentity');
const { hashRequestFingerprint } = require('../services/siteQuota');
const { extractUserInfo } = require('../middleware/auth');
const { resolveUsageAttributionUserId } = require('../services/usageAttribution');
const { buildTrialGenerationForSingleRequest } = require('../lib/trialGenerationContract');
const { buildEntitlementState } = require('../services/entitlementState');
const { GENERATION_ERROR_CODES, publicMessageFor } = require('../lib/generationErrors');
const { normalizeImageForProvider, ImageNormalizationError } = require('../lib/imageNormalization');

function hashPayload(base64) {
  return crypto.createHash('md5').update(base64).digest('hex');
}

function hasValidAdminKey(adminKey) {
  return Boolean(process.env.ADMIN_KEY && adminKey && adminKey === process.env.ADMIN_KEY);
}

function summarizeInvalidAltTextPayload(body = {}) {
  const image = body && typeof body === 'object' ? body.image : null;
  const context = body && typeof body === 'object' ? body.context : null;

  return {
    top_level_keys: body && typeof body === 'object' ? Object.keys(body).slice(0, 20) : [],
    image_keys: image && typeof image === 'object' ? Object.keys(image).slice(0, 20) : [],
    has_base64: Boolean(image?.base64 || image?.image_base64),
    base64_length: typeof image?.base64 === 'string'
      ? image.base64.length
      : (typeof image?.image_base64 === 'string' ? image.image_base64.length : 0),
    has_url: Boolean(image?.url),
    context_keys: context && typeof context === 'object' ? Object.keys(context).slice(0, 20) : []
  };
}

function extractIdempotencyKey(req) {
  return req.header('Idempotency-Key')
    || req.header('X-Idempotency-Key')
    || req.body?.idempotency_key
    || req.body?.idempotencyKey
    || null;
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') {
      return value.trim();
    }
  }
  return null;
}

function sanitizeTelemetryValue(...args) {
  const last = args[args.length - 1];
  const maxLength = typeof last === 'number' ? last : 255;
  const values = typeof last === 'number' ? args.slice(0, -1) : args;
  const normalized = firstString(...values);
  return normalized ? normalized.slice(0, maxLength) : null;
}

function extractRequestTelemetry(req, body = {}) {
  const siteUrl = sanitizeTelemetryValue(
    req.header('X-Site-URL'),
    body.site_url,
    body.siteUrl,
    body.trial_site_url,
    500
  );

  return {
    site_url: siteUrl,
    domain: normalizeDomain(siteUrl),
    wp_version: sanitizeTelemetryValue(req.header('X-WP-Version'), body.wp_version, body.wpVersion, 64),
    php_version: sanitizeTelemetryValue(req.header('X-PHP-Version'), body.php_version, body.phpVersion, 64),
    install_hash: sanitizeTelemetryValue(
      req.header('X-Install-Hash'),
      req.header('X-Install-UUID'),
      req.header('X-WP-Install-UUID'),
      body.install_hash,
      body.installHash,
      body.install_uuid,
      body.installUuid,
      255
    ),
    auth_state: sanitizeTelemetryValue(req.header('X-Auth-State'), body.auth_state, body.authState, 64),
    plan_key: sanitizeTelemetryValue(req.header('X-Plan-Key'), body.plan_key, body.planKey, 64),
    request_source: sanitizeTelemetryValue(req.header('X-Request-Source'), body.request_source, body.requestSource, 64),
    plugin_channel: sanitizeTelemetryValue(req.header('X-Plugin-Channel'), body.plugin_channel, body.pluginChannel, 64),
    environment: sanitizeTelemetryValue(req.header('X-Environment'), body.environment, 64),
    request_id: sanitizeTelemetryValue(req.id, req.header('X-Request-ID'), body.request_id, body.requestId, 128),
    generation_batch_id: sanitizeTelemetryValue(body.generation_batch_id, body.generationBatchId, 128),
    user_agent: sanitizeTelemetryValue(req.get('user-agent'), 1000)
  };
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

function buildGenerationEntitlementState(req, {
  quotaStatus = null,
  anonymousResponseFields = null,
  responseFields = null
} = {}) {
  const source = req.trialMode
    ? (anonymousResponseFields || responseFields || {})
    : (quotaStatus && !quotaStatus.error ? quotaStatus : (responseFields || {}));

  return buildEntitlementState(source, {
    isLoggedIn: !req.trialMode,
    isTrial: Boolean(req.trialMode)
  });
}

function extractGenerationRunId(req) {
  return sanitizeTelemetryValue(
    req.header('X-Generation-Run-ID'),
    req.header('X-Generation-Run-Id'),
    req.body?.generation_run_id,
    req.body?.generationRunId,
    128
  ) || crypto.randomUUID();
}

function extractRetryCount(req) {
  const raw = firstString(
    req.header('X-Generation-Attempt'),
    req.header('X-Retry-Count'),
    typeof req.body?.retry_count === 'number' ? String(req.body.retry_count) : req.body?.retry_count
  );
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

/**
 * Per-request generation telemetry.
 *
 * Guarantees exactly one terminal analytics event per HTTP request: once a
 * terminal event (generation_completed, generation_failed, or the legacy
 * generation_blocked_no_credits) has been emitted, later terminal emissions
 * are no-ops. All events carry the generation_run_id so client retries of
 * the same logical operation can be grouped in PostHog and in logs.
 */
function createGenerationTelemetry({
  req,
  generationRunId,
  retryCount,
  startedAt
}) {
  let terminalEmitted = false;
  let siteIdentityRef = null;
  let requestTelemetry = null;
  let imageMeta = null;

  function capture(event, {
    entitlementState = null,
    outcome = null,
    errorCode = null,
    httpStatus = null,
    retryable = null,
    isTerminal = false
  } = {}) {
    const distinctId = siteIdentityRef?.siteHash || null;
    if (!distinctId) return;
    const siteUrl = siteIdentityRef?.siteUrl || req?.header?.('X-Site-URL') || null;

    captureServerEvent({
      event,
      distinctId,
      properties: {
        generation_run_id: generationRunId,
        request_id: req?.id || null,
        site_url: siteUrl,
        domain: normalizeDomain(siteUrl),
        auth_state: req?.trialMode ? 'guest_trial' : 'authenticated',
        plan: entitlementState?.plan || null,
        quota_state: entitlementState?.quota_state || null,
        tokens_remaining: entitlementState?.tokens_remaining ?? null,
        outcome,
        error_code: errorCode,
        http_status: httpStatus,
        retryable,
        original_format: imageMeta?.original_format ?? null,
        provider_format: imageMeta?.provider_format ?? null,
        image_converted: imageMeta?.image_converted ?? null,
        conversion_duration_ms: imageMeta?.conversion_duration_ms ?? null,
        image_width: imageMeta?.image_width ?? null,
        image_height: imageMeta?.image_height ?? null,
        has_alpha: imageMeta?.has_alpha ?? null,
        plugin_version: sanitizeTelemetryValue(req?.header?.('X-Plugin-Version'), 64),
        generation_mode: 'single',
        retry_count: retryCount,
        duration_ms: Date.now() - startedAt,
        provider: 'openai',
        environment: requestTelemetry?.environment || process.env.NODE_ENV || null,
        request_source: requestTelemetry?.request_source || 'wordpress_plugin',
        is_terminal: isTerminal,
        site_hash: distinctId
      }
    }).catch((error) => {
      logger.warn('[analytics] generation_event_capture_failed', {
        event,
        generation_run_id: generationRunId,
        request_id: req?.id || null,
        error: error.message
      });
    });
  }

  return {
    bindContext({ siteIdentity = null, telemetry = null, imageMeta: nextImageMeta = null } = {}) {
      if (siteIdentity) siteIdentityRef = siteIdentity;
      if (telemetry) requestTelemetry = telemetry;
      if (nextImageMeta) imageMeta = nextImageMeta;
    },
    emitTerminal(event, options = {}) {
      if (terminalEmitted) {
        logger.warn('[analytics] duplicate_terminal_generation_event_suppressed', {
          event,
          generation_run_id: generationRunId,
          request_id: req?.id || null
        });
        return false;
      }
      terminalEmitted = true;
      capture(event, { ...options, isTerminal: true });
      return true;
    },
    emitSignal(event, options = {}) {
      capture(event, { ...options, isTerminal: false });
    },
    hasEmittedTerminal() {
      return terminalEmitted;
    }
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
      altTextSuggestion: z.string().optional(),
      tone: z.string().optional(),
      descriptionStyle: z.string().optional(),
      customPrompt: z.string().optional(),
      additionalInstructions: z.string().optional()
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
    const startedAt = Date.now();
    const generationRunId = extractGenerationRunId(req);
    const retryCount = extractRetryCount(req);
    const telemetry = createGenerationTelemetry({ req, generationRunId, retryCount, startedAt });
    res.setHeader('X-Generation-Run-Id', generationRunId);

    try {
      return await handleGeneration(req, res, { generationRunId, retryCount, telemetry });
    } catch (error) {
      // Last-resort handler: an unexpected exception anywhere in the flow
      // must still resolve to exactly one terminal analytics event and a
      // single HTTP response. Unknown failures are generation_failed with
      // error_code internal_unknown_error (never a second event type).
      logger.error('[altText] Unhandled generation exception', {
        generation_run_id: generationRunId,
        request_id: req.id || null,
        error: error.message,
        stack: error.stack
      });
      telemetry.emitTerminal('generation_failed', {
        outcome: 'INTERNAL_ERROR',
        errorCode: GENERATION_ERROR_CODES.INTERNAL_UNKNOWN_ERROR,
        httpStatus: 500,
        retryable: false
      });
      if (!res.headersSent) {
        return res.status(500).json({
          error: 'INTERNAL_ERROR',
          code: 'INTERNAL_ERROR',
          error_code: GENERATION_ERROR_CODES.INTERNAL_UNKNOWN_ERROR,
          generation_run_id: generationRunId,
          message: 'Failed to generate alt text.',
          retryable: false
        });
      }
      return undefined;
    }
  });

  async function handleGeneration(req, res, { generationRunId, retryCount, telemetry }) {
    const parsed = requestSchema.safeParse(req.body);
    if (!parsed.success) {
      logger.error('[altText] Schema validation failed', {
        generation_run_id: generationRunId,
        errors: parsed.error.flatten(),
        payload: summarizeInvalidAltTextPayload(req.body)
      });
      return res.status(400).json({
        error: 'INVALID_REQUEST',
        code: 'INVALID_REQUEST',
        error_code: GENERATION_ERROR_CODES.INVALID_REQUEST,
        generation_run_id: generationRunId,
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
      installUuid: req.trialMode
        ? (req.header('X-Install-Hash') || req.header('X-Install-UUID') || req.trialSiteHash)
        : (req.header('X-Install-Hash') || req.header('X-Install-UUID') || req.header('X-Site-Key') || req.header('X-Site-Hash') || req.body?.install_hash || req.body?.installHash || req.body?.site_id || req.body?.siteId || null),
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
    const requestTelemetry = extractRequestTelemetry(req, req.body || {});
    telemetry.bindContext({ siteIdentity, telemetry: requestTelemetry });

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
      generation_run_id: generationRunId,
      retry_count: retryCount,
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

    // Validate and normalize image payload FIRST to get clean base64.
    // Unsupported formats (e.g. AVIF/HEIC) are rejected here, before any
    // quota reservation or provider call, as a terminal 400 the client
    // must not retry.
    const { errors, warnings, normalized } = validateImagePayload(image);
    if (errors.length) {
      logger.error('[altText] Image validation failed', {
        generation_run_id: generationRunId,
        request_id: req.id || null,
        errors,
        warnings,
        imageKeys: Object.keys(image),
        hasBase64: !!(image.base64 || image.image_base64),
        base64Length: (image.base64 || image.image_base64 || '').length,
        hasUrl: !!image.url,
        width: image.width,
        height: image.height
      });
      telemetry.emitTerminal('generation_failed', {
        outcome: 'INVALID_REQUEST',
        errorCode: GENERATION_ERROR_CODES.INVALID_REQUEST,
        httpStatus: 400,
        retryable: false
      });
      return res.status(400).json({
        error: 'INVALID_REQUEST',
        code: 'INVALID_REQUEST',
        error_code: GENERATION_ERROR_CODES.INVALID_REQUEST,
        generation_run_id: generationRunId,
        message: 'Image validation failed',
        retryable: false,
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

    {
      const isProdLogging = process.env.NODE_ENV === 'production';
      logger.info('[altText] Image details', isProdLogging
        ? {
          imageSource: normalizedBase64 ? 'base64' : (normalized.url ? 'url' : 'none'),
          cacheKey: cacheKey ? cacheKey.substring(0, 16) + '...' : null,
          bypassCache,
          regenerate,
          warnings: warnings.length
        }
        : {
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
    }
    
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
        const isProdLogging = process.env.NODE_ENV === 'production';
        logger.info('[altText] Cache hit - returning cached result', {
          cacheKey: cacheKey ? cacheKey.substring(0, 16) + '...' : null,
          cachedAltTextLength: typeof cachedData.altText === 'string' ? cachedData.altText.length : 0,
          ...(isProdLogging ? {} : {
            cachedAltTextPreview: typeof cachedData.altText === 'string'
              ? `${cachedData.altText.slice(0, 60)}${cachedData.altText.length > 60 ? '…' : ''}`
              : null
          }),
          cachedModel: cachedData.meta?.modelUsed
        });

        // Fetch current quota status to include accurate credits in cached response
        // This ensures the plugin gets up-to-date usage info even from cache
        let creditsInfo = {};
        let trialInfo = null;
        let anonymousResponseFields = null;
        let cachedQuotaStatus = null;
        try {
          const quotaStatus = await getQuotaStatus(supabase, {
            account: req.user || req.license || null,
            licenseKey,
            siteIdentity,
            quotaMode: req.trialMode ? 'trial' : 'site',
            requestId: req.id || null
          });
          cachedQuotaStatus = quotaStatus;
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
          entitlement_state: buildGenerationEntitlementState(req, {
            quotaStatus: cachedQuotaStatus,
            anonymousResponseFields,
            responseFields: creditsInfo
          }),
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

    // Normalize the image for the provider (e.g. AVIF → WebP) BEFORE any
    // quota is reserved: a conversion failure is a permanent input error
    // that must never touch quota or reach the provider.
    let providerImage = normalized;
    if (normalized.base64) {
      let normalization;
      try {
        normalization = await normalizeImageForProvider({
          buffer: Buffer.from(normalized.base64, 'base64'),
          declaredMimeType: normalized.mime_type,
          filename: normalized.filename,
          source: 'api/alt-text',
          logContext: {
            generation_run_id: generationRunId,
            request_id: req.id || null
          }
        });
      } catch (error) {
        if (!(error instanceof ImageNormalizationError)) throw error;
        logger.warn('[altText] Image normalization failed', {
          generation_run_id: generationRunId,
          request_id: req.id || null,
          error_code: error.errorCode,
          http_status: error.httpStatus,
          site_hash: siteIdentity.siteHash || null,
          error: error.message
        });
        telemetry.emitTerminal('generation_failed', {
          outcome: error.errorCode,
          errorCode: error.errorCode,
          httpStatus: error.httpStatus,
          retryable: false
        });
        return res.status(error.httpStatus).json({
          success: false,
          error: error.errorCode,
          code: error.errorCode,
          error_code: error.errorCode,
          generation_run_id: generationRunId,
          message: error.publicMessage,
          retryable: false
        });
      }

      telemetry.bindContext({
        imageMeta: {
          original_format: normalization.originalFormat,
          provider_format: normalization.format,
          image_converted: normalization.converted,
          conversion_duration_ms: normalization.converted ? normalization.durationMs : null,
          image_width: normalization.width,
          image_height: normalization.height,
          has_alpha: normalization.hasAlpha
        }
      });

      if (normalization.converted) {
        providerImage = {
          ...normalized,
          base64: normalization.buffer.toString('base64'),
          mime_type: normalization.mimeType,
          width: normalization.width || normalized.width,
          height: normalization.height || normalized.height
        };
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
      generation_run_id: generationRunId,
      retry_count: retryCount,
      endpoint: 'api/alt-text',
      image_filename: normalized.filename || null,
      image_url: normalized.url || null,
      plugin_version: userInfo.plugin_version || null,
      install_hash: requestTelemetry.install_hash || null,
      auth_state: req.trialMode ? 'guest_trial' : (requestTelemetry.auth_state || null),
      plan_key: requestTelemetry.plan_key || null,
      request_source: requestTelemetry.request_source || 'wordpress_plugin',
      plugin_channel: requestTelemetry.plugin_channel || null,
      environment: requestTelemetry.environment || null,
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
        quotaMode: 'trial',
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
          entitlement_state: buildGenerationEntitlementState(req, {
            anonymousResponseFields
          }),
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
      let deniedQuotaStatus = null;
      if (req.trialMode) {
        try {
          const quotaStatus = await getQuotaStatus(supabase, {
            account: req.user || req.license || null,
            licenseKey,
            siteIdentity,
            quotaMode: 'trial',
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
      } else {
        try {
          deniedQuotaStatus = await getQuotaStatus(supabase, {
            account: req.user || req.license || null,
            licenseKey,
            siteIdentity,
            quotaMode: 'site',
            requestId: req.id || null
          });
        } catch (_err) {
          // Best-effort: preserve the existing quota rejection response.
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

      const deniedResponseFields = {
        error: reservation.error,
        message: reservation.message || 'Quota exceeded',
        code: reservation.error,
        credits_used: anonymousResponseFields?.credits_used ?? reservation.payload?.credits_used ?? deniedQuotaStatus?.credits_used,
        credits_remaining: anonymousResponseFields?.credits_remaining ?? reservation.payload?.remaining_credits ?? reservation.payload?.credits_remaining ?? deniedQuotaStatus?.credits_remaining,
        credits_total: anonymousResponseFields?.credits_total ?? reservation.payload?.total_limit ?? deniedQuotaStatus?.total_limit,
        total_limit: anonymousResponseFields?.credits_total ?? reservation.payload?.total_limit ?? deniedQuotaStatus?.total_limit,
        reset_date: reservation.payload?.quota_period_end || reservation.payload?.reset_date || deniedQuotaStatus?.reset_date,
        remaining: anonymousResponseFields?.credits_remaining ?? reservation.payload?.remaining_credits ?? reservation.payload?.credits_remaining ?? deniedQuotaStatus?.credits_remaining,
        ...(trialInfo || {}),
        ...(anonymousResponseFields || {}),
        trial_exhausted: anonymousResponseFields?.trial_exhausted === true || reservation.error === 'TRIAL_EXHAUSTED' ? true : undefined,
        ...(trialGenerationDenied ? { trial_generation: trialGenerationDenied } : {})
      };
      deniedResponseFields.entitlement_state = buildGenerationEntitlementState(req, {
        quotaStatus: deniedQuotaStatus,
        anonymousResponseFields,
        responseFields: deniedResponseFields
      });
      telemetry.emitTerminal('generation_blocked_no_credits', {
        entitlementState: deniedResponseFields.entitlement_state,
        outcome: reservation.error,
        errorCode: GENERATION_ERROR_CODES.QUOTA_EXHAUSTED,
        httpStatus: reservation.status || 402
      });

      deniedResponseFields.generation_run_id = generationRunId;
      return res.status(reservation.status || 402).json(deniedResponseFields);
    }

    logger.info('[altText] Quota reserved, calling OpenAI', {
      generation_run_id: generationRunId,
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
        image: providerImage,
        context: { ...context, filename: normalized.filename }
      });
      altText = generationResult.altText;
      usage = generationResult.usage;
      meta = generationResult.meta;
      generationTime = Date.now() - startTime;
    } catch (error) {
      const normalizedErrorCode = error.errorCode || GENERATION_ERROR_CODES.INTERNAL_ERROR;
      const errorCode = error.code || 'GENERATION_FAILED';
      const isRetryable = error.isRetryable === true;
      // Prefer the classified client status; a non-retryable provider 400
      // (e.g. unsupported image) must surface as 4xx, never 500, so client
      // retry loops don't amplify one bad image into many failed attempts.
      const httpStatus = error.httpStatusForClient
        || (errorCode === 'BACKEND_CONFIG_ERROR' ? 502
          : errorCode === 'UPSTREAM_RATE_LIMITED' ? 503
          : errorCode === 'UPSTREAM_GENERATION_ERROR' ? 502
          : 500);

      const finalizeResult = await finalizeGenerationQuotaReservation(supabase, {
        generationRequestId: reservation.reservation?.generation_request_id || null,
        success: false,
        finalMetadata: {
          error_message: error.message,
          error_code: errorCode,
          normalized_error_code: normalizedErrorCode,
          generation_run_id: generationRunId,
          retry_count: retryCount,
          request_id: req.id || null
        }
      });

      logger.error('[altText] Alt text generation failed', {
        error: error.message,
        code: errorCode,
        error_code: normalizedErrorCode,
        http_status: httpStatus,
        provider_status: error.httpStatus || null,
        isRetryable,
        trialMode: !!req.trialMode,
        generation_run_id: generationRunId,
        retry_count: retryCount,
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

      telemetry.emitTerminal('generation_failed', {
        outcome: errorCode,
        errorCode: normalizedErrorCode,
        httpStatus,
        retryable: isRetryable
      });

      return res.status(httpStatus).json({
        error: errorCode,
        code: errorCode,
        error_code: normalizedErrorCode,
        generation_run_id: generationRunId,
        message: publicMessageFor(normalizedErrorCode),
        retryable: isRetryable,
        ...(trialInfo || {}),
        ...(anonymousResponseFields || {}),
        ...(trialGenerationFailed ? { trial_generation: trialGenerationFailed } : {})
      });
    }
    
    {
      const isProdLogging = process.env.NODE_ENV === 'production';
      logger.info('[altText] Alt text generated', {
        altTextLength: altText ? altText.length : 0,
        ...(isProdLogging ? {} : {
          altTextPreview: altText
            ? `${altText.slice(0, 80)}${altText.length > 80 ? '…' : ''}`
            : null
        }),
        generationTimeMs: generationTime,
        modelUsed: meta?.modelUsed,
        tokensUsed: usage?.total_tokens
      });
    }

    const finalizeResult = await finalizeGenerationQuotaReservation(supabase, {
      generationRequestId: reservation.reservation?.generation_request_id || null,
      success: true,
      finalMetadata: {
        request_id: req.id || null,
        generation_run_id: generationRunId,
        retry_count: retryCount,
        cached: false,
        model_used: meta?.modelUsed || null,
        total_tokens: usage?.total_tokens || null
      }
    });

    // Record usage/credits
    let usageResult = { error: null };
    let trialUsageResult = null;
    const effectiveSite = reservation.site || null;
    const effectiveLicenseKey = effectiveSite?.license_key || licenseKey || null;

    if (req.trialMode) {
      const trialUsageLogPayload = {
        licenseKey: null,
        licenseId: null,
        siteHash: effectiveSite?.site_hash || siteIdentity.siteHash || req.trialSiteHash,
        installHash: requestTelemetry.install_hash || siteIdentity.wpInstallUuid || null,
        siteUrl: requestTelemetry.site_url || siteIdentity.siteUrl || null,
        domain: requestTelemetry.domain || normalizeDomain(siteIdentity.siteUrl),
        userId: null,
        userEmail: null,
        pluginVersion: userInfo.plugin_version,
        wpVersion: requestTelemetry.wp_version || userInfo.wp_version,
        phpVersion: requestTelemetry.php_version || userInfo.php_version,
        authState: 'guest_trial',
        planKey: 'trial',
        requestSource: requestTelemetry.request_source || 'wordpress_plugin',
        pluginChannel: requestTelemetry.plugin_channel,
        environment: requestTelemetry.environment,
        requestId: requestTelemetry.request_id || req.id,
        generationBatchId: requestTelemetry.generation_batch_id,
        userAgent: requestTelemetry.user_agent,
        imageCount: 1,
        eventType: 'generation',
        isTrial: true,
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
      };

      if (reservation.reservation?.quota_source === 'legacy_trial') {
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
        logger.warn('[altText] Recording anonymous trial usage via legacy fallback', {
          site_hash: trialPayload.site_hash,
          anon_id: anonymousContext.anonId || null,
          risk_key: anonymousContext.riskKey || null,
          quota_source: reservation.reservation?.quota_source || null
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
        trialUsageResult = usageResult;
        const trialUsageLog = await recordUsage(supabase, trialUsageLogPayload);
        if (trialUsageLog.error) {
          logger.warn('[usage] anonymous_trial_usage_logs_write_failed', {
            site_hash: trialUsageLogPayload.siteHash || null,
            request_id: req.id || null,
            error: serializeSupabaseError(trialUsageLog.error)
          });
        }
      } else {
        logger.info('[altText] Anonymous trial usage recorded by V2 site_trials', {
          site_hash: effectiveSite?.site_hash || siteIdentity.siteHash || req.trialSiteHash,
          site_id: effectiveSite?.id || reservation.site?.id || null,
          anon_id: anonymousContext.anonId || null,
          quota_source: reservation.reservation?.quota_source || null,
          generation_request_id: reservation.reservation?.generation_request_id || null
        });
        const trialUsageLog = await recordUsage(supabase, trialUsageLogPayload);
        if (trialUsageLog.error) {
          logger.warn('[usage] anonymous_trial_usage_logs_write_failed', {
            site_hash: trialUsageLogPayload.siteHash || null,
            request_id: req.id || null,
            error: serializeSupabaseError(trialUsageLog.error)
          });
        }
      }
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

      const attribution = await resolveUsageAttributionUserId(supabase, {
        req,
        siteHash: effectiveSite?.site_hash || siteKey,
        effectiveSite,
        licenseId
      });

      if (!attribution.userId) {
        logger.warn('[usage] attribution_missing', {
          endpoint: 'api/alt-text',
          status: 'success',
          site_hash_present: Boolean(effectiveSite?.site_hash || siteKey),
          license_id_present: Boolean(licenseId),
          reason: attribution.reason || 'unknown'
        });
      }

      logger.info('[altText] Recording usage', {
        licenseKey: effectiveLicenseKey ? `${effectiveLicenseKey.substring(0, 8)}...` : 'missing',
        licenseId: licenseId ? `${licenseId.substring(0, 8)}...` : 'missing',
        siteKey: effectiveSite?.site_hash || siteKey,
        userId: attribution.userId || null,
        creditsUsed: 1
      });

      usageResult = await recordUsage(supabase, {
        licenseKey: effectiveLicenseKey,
        licenseId: licenseId || attribution.userId || null,
        siteHash: effectiveSite?.site_hash || siteKey,
        userId: null,
        userEmail: userInfo.user_email,
        pluginVersion: userInfo.plugin_version,
        wpVersion: requestTelemetry.wp_version || userInfo.wp_version,
        phpVersion: requestTelemetry.php_version || userInfo.php_version,
        siteUrl: requestTelemetry.site_url || siteIdentity.siteUrl,
        domain: requestTelemetry.domain || normalizeDomain(siteIdentity.siteUrl),
        installHash: requestTelemetry.install_hash,
        authState: requestTelemetry.auth_state || (licenseId ? 'authenticated_paid' : 'authenticated_free'),
        planKey: requestTelemetry.plan_key,
        requestSource: requestTelemetry.request_source || 'wordpress_plugin',
        pluginChannel: requestTelemetry.plugin_channel,
        environment: requestTelemetry.environment,
        requestId: requestTelemetry.request_id || req.id,
        generationBatchId: requestTelemetry.generation_batch_id,
        userAgent: requestTelemetry.user_agent,
        imageCount: 1,
        eventType: 'generation',
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

      logger.debug('[usage] attribution_debug', {
        usage_log_id: usageResult?.data?.id || null,
        site_hash_present: Boolean(effectiveSite?.site_hash || siteKey),
        license_id_present: Boolean(licenseId),
        user_id_source: attribution.source,
        endpoint: 'api/alt-text',
        credits_used: 1
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

    // Reduce risk of logging generated content in production environments.
    // (Alt text is user-facing content; keep only length/metadata in prod logs.)
    // Note: the response payload still contains the generated altText (required by plugin).

    logGenerationAccountingTrace({
      requestId: req.id || null,
      reservation,
      effectiveSite,
      effectiveLicenseKey,
      userInfo,
      usageWrite: req.trialMode ? null : usageResult,
      trialWrite: req.trialMode ? trialUsageResult : null,
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
      quotaMode: req.trialMode ? 'trial' : 'site',
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
      generation_run_id: generationRunId,
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
    response.entitlement_state = buildGenerationEntitlementState(req, {
      quotaStatus,
      anonymousResponseFields,
      responseFields: response
    });
    telemetry.emitTerminal('generation_completed', {
      entitlementState: response.entitlement_state,
      outcome: 'success',
      httpStatus: 200
    });
    if (!response.entitlement_state.can_generate && response.entitlement_state.tokens_remaining === 0) {
      telemetry.emitSignal('credits_exhausted', {
        entitlementState: response.entitlement_state,
        outcome: 'final_generation',
        httpStatus: 200
      });
    }

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
      generation_run_id: generationRunId,
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
    return undefined;
  }

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
