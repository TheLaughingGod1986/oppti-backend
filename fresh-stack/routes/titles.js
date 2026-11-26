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
const { isFlagOn } = require('../services/redirectAllowlist');
const { buildAnonymousContext } = require('../lib/anonymousIdentity');
const { buildAnonymousTrialStatus, getAnonymousTrialLimit } = require('../services/anonymousTrial');
const { buildEntitlementState } = require('../services/entitlementState');
const { buildTrialGenerationForSingleRequest } = require('../lib/trialGenerationContract');
const { normalizeDomain } = require('../lib/siteIdentity');
const { siteRefForLog } = require('../lib/logIdentity');
const {
  TITLES_GUEST_CREDITS_PER_TRY,
  buildGuestReservationKeys,
  buildGuestSiteIdentity
} = require('../services/titlesGuestTrial');

// X-Request-Source the Titles plugin sends for Autopilot (paid feature).
const TITLES_AUTOPILOT_SOURCE = 'beepbeep_titles_autopilot';

function isAutopilotRequest(req) {
  return String(req.header('X-Request-Source') || '').trim().toLowerCase() === TITLES_AUTOPILOT_SOURCE;
}

function isAutopilotFreeBlockEnforced(env = process.env) {
  return isFlagOn(env.TITLES_AUTOPILOT_FREE_BLOCK_ENFORCE);
}

const AUTOPILOT_REQUIRES_PAID_PLAN = Object.freeze({
  success: false,
  error: 'AUTOPILOT_REQUIRES_PAID_PLAN',
  code: 'AUTOPILOT_REQUIRES_PAID_PLAN',
  message: 'Autopilot is available on paid plans. Upgrade to turn it on.',
  upgrade_required: true
});

/**
 * Free accounts may not run Titles Autopilot. Log-only unless
 * TITLES_AUTOPILOT_FREE_BLOCK_ENFORCE is on. The plan comes from the shared
 * wallet (site subscription first), not the drift-prone licenses.plan column.
 * An unresolved plan never blocks. Returns true when the request was refused.
 */
async function refuseFreeAutopilot(req, res, { status, route }) {
  if (!isAutopilotRequest(req)) return false;
  const plan = status && !status.error ? String(status.plan || '').toLowerCase() : null;
  if (plan !== 'free') {
    if (!plan) {
      logger.warn('[titles] autopilot_plan_unresolved', {
        route,
        account_id: resolveAccount(req)?.id || null,
        error: status?.error || null
      });
    }
    return false;
  }
  const enforced = isAutopilotFreeBlockEnforced();
  logger.warn('[titles] autopilot_free_account', {
    route,
    account_id: resolveAccount(req)?.id || null,
    site_id: status?.site_id || null,
    enforced,
    action: enforced ? 'refused' : 'allowed_log_only'
  });
  if (!enforced) return false;
  res.status(403).json(AUTOPILOT_REQUIRES_PAID_PLAN);
  return true;
}

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

const TITLES_GENERATE_ENDPOINT = 'api/titles/generate';

/**
 * Trial status for a guest response, from the reservation payload when it
 * has one (no extra database read).
 */
function guestTrialStatusFromReservation(payload, anonId) {
  const limit = Number(payload?.total_limit);
  const remaining = Number(payload?.remaining_credits);
  const normalizedLimit = Number.isFinite(limit) && limit > 0 ? limit : getAnonymousTrialLimit();
  const used = Number.isFinite(remaining)
    ? Math.max(normalizedLimit - remaining, 0)
    : Number(payload?.credits_used) || 0;
  return buildAnonymousTrialStatus({ used, limit: normalizedLimit, anonId });
}

/**
 * Signed-out Titles generation (guest first result). See
 * services/titlesGuestTrial.js for the design. Order matters:
 *   1. resolve the per-site guest key from the site URL;
 *   2. per-site/per-client rate limit (as Alt Text);
 *   3. check AND reserve one try from the site's trial bucket;
 *   4. only then generate. Nothing earlier can return a result.
 */
async function handleGuestGenerate(req, res, { supabase, checkRateLimit, page, options, previous }) {
  const guest = buildGuestSiteIdentity(req);
  if (guest.error) {
    return res.status(guest.error === 'GUEST_SITE_URL_REQUIRED' ? 400 : 403).json({
      success: false,
      error: guest.error,
      code: guest.error,
      message: guest.error === 'GUEST_SITE_URL_REQUIRED'
        ? 'A site URL is required for a guest generation.'
        : 'Site identity could not be resolved.'
    });
  }
  const { siteIdentity, guestSiteKey } = guest;
  const anonymousContext = req.anonymous || buildAnonymousContext({ req, body: req.body, siteIdentity });
  const anonId = anonymousContext?.anonId || null;

  const rateLimitKey = `titles-guest:${guestSiteKey}:${anonymousContext?.riskKey || anonId || 'anonymous'}:${req.ip || 'unknown-ip'}`;
  if (typeof checkRateLimit === 'function' && !(await checkRateLimit(rateLimitKey))) {
    return res.status(429).json({
      success: false,
      error: 'RATE_LIMIT_EXCEEDED',
      code: 'RATE_LIMIT_EXCEEDED',
      message: 'Rate limit exceeded'
    });
  }

  const userInfo = extractUserInfo(req);
  const baseFingerprint = buildTitleRequestFingerprint({
    siteKey: guestSiteKey,
    userInfo,
    page,
    options,
    previous
  });
  const { idempotencyKey, requestFingerprint } = buildGuestReservationKeys(baseFingerprint);

  const reservation = await reserveTitleGenerationQuota(supabase, {
    account: null,
    licenseKey: null,
    siteIdentity,
    creditsNeeded: TITLES_GUEST_CREDITS_PER_TRY,
    quotaMode: 'trial',
    idempotencyKey,
    requestFingerprint,
    requestMetadata: {
      endpoint: TITLES_GENERATE_ENDPOINT,
      guest: true,
      guest_site_key: guestSiteKey,
      auth_state: 'guest_trial',
      regenerate: Boolean(previous && (previous.title || previous.meta)),
      credits_per_page: TITLES_GUEST_CREDITS_PER_TRY,
      plugin_version: userInfo?.plugin_version || null,
      request_source: req.header('X-Request-Source') || null,
      anon_id: anonId,
      anonymous_risk_key: anonymousContext?.riskKey || null,
      anonymous_ip_hash: anonymousContext?.ipHash || null
    },
    requestId: req.id || null
  });

  if (reservation.error) {
    const trialInfo = reservation.error === 'TRIAL_EXHAUSTED'
      ? guestTrialStatusFromReservation(reservation.payload, anonId)
      : null;
    logger.warn('[titles] guest_quota_denied', {
      ...siteRefForLog(reservation.site?.site_hash || guestSiteKey, req),
      code: reservation.error,
      credits_used: trialInfo?.credits_used ?? null,
      credits_total: trialInfo?.credits_total ?? null
    });
    if (!trialInfo) {
      return res.status(reservation.status || 500).json({
        success: false,
        error: reservation.error,
        code: reservation.error,
        message: reservation.message || 'Guest generation unavailable'
      });
    }
    // Same body as the Alt Text guest cap (routes/altText.js, TRIAL_EXHAUSTED).
    return res.status(402).json({
      success: false,
      error: 'TRIAL_EXHAUSTED',
      code: 'TRIAL_EXHAUSTED',
      message: 'Free trial exhausted. Create a free account to keep generating titles and meta.',
      credits_used: trialInfo.credits_used,
      credits_remaining: trialInfo.credits_remaining,
      credits_total: trialInfo.credits_total,
      total_limit: trialInfo.total_limit,
      remaining: trialInfo.credits_remaining,
      ...trialInfo,
      trial_exhausted: true,
      entitlement_state: buildEntitlementState(trialInfo, { isLoggedIn: false, isTrial: true }),
      trial_generation: buildTrialGenerationForSingleRequest({
        outcome: 'quota_denied',
        trialLimit: trialInfo.trial_limit,
        trialUsedBefore: trialInfo.trial_used,
        trialRemainingBefore: trialInfo.trial_remaining,
        trialUsedAfter: trialInfo.trial_used,
        trialRemainingAfter: trialInfo.trial_remaining
      })
    });
  }

  // Keys are unique per request, so a replay can only mean something else
  // answered for this key. Never generate on it.
  if (reservation.reservation?.duplicate) {
    logger.warn('[titles] guest_duplicate_reservation_refused', {
      ...siteRefForLog(reservation.site?.site_hash || guestSiteKey, req),
      generation_request_id: reservation.reservation?.generation_request_id || null
    });
    return res.status(409).json({
      success: false,
      error: 'GUEST_DUPLICATE_REQUEST',
      code: 'GUEST_DUPLICATE_REQUEST',
      message: 'This request was already handled.'
    });
  }

  const generationRequestId = reservation.reservation?.generation_request_id || null;
  const effectiveSite = reservation.site || null;
  const trialAfter = guestTrialStatusFromReservation(reservation.reservation, anonId);
  const trialBefore = buildAnonymousTrialStatus({
    used: Math.max(trialAfter.trial_used - TITLES_GUEST_CREDITS_PER_TRY, 0),
    limit: trialAfter.trial_limit,
    anonId
  });

  const genStart = Date.now();
  try {
    const result = await generateTitleAndMeta({ page, options, previous });
    const generationTimeMs = Date.now() - genStart;

    const finalizeResult = await finalizeTitleGenerationQuota(supabase, {
      generationRequestId,
      success: true,
      finalMetadata: {
        guest: true,
        guest_site_key: guestSiteKey,
        model_used: result.meta_info?.modelUsed || null,
        total_tokens: result.usage?.total_tokens || null,
        regenerated: Boolean(previous)
      }
    });

    const siteUrl = siteIdentity.siteUrl || null;
    const usageWrite = await recordUsage(supabase, {
      licenseKey: null,
      licenseId: null,
      siteHash: effectiveSite?.site_hash || guestSiteKey,
      installHash: null,
      siteUrl,
      domain: normalizeDomain(siteUrl),
      userId: null,
      userEmail: null,
      pluginVersion: userInfo?.plugin_version,
      authState: 'guest_trial',
      planKey: 'trial',
      isTrial: true,
      creditsUsed: TITLES_GUEST_CREDITS_PER_TRY,
      promptTokens: result.usage?.prompt_tokens,
      completionTokens: result.usage?.completion_tokens,
      totalTokens: result.usage?.total_tokens,
      cached: false,
      modelUsed: result.meta_info?.modelUsed || null,
      generationTimeMs,
      endpoint: TITLES_GENERATE_ENDPOINT,
      eventType: 'generation',
      status: 'success',
      featureType: TITLES_FEATURE_TYPE,
      requestSource: req.header('X-Request-Source') || null,
      pluginChannel: req.header('X-Plugin-Channel') || null,
      environment: req.header('X-Environment') || null,
      requestId: req.id || null,
      userAgent: req.get('user-agent') || null
    });
    if (usageWrite?.error) {
      logger.warn('[titles] guest_usage_log_write_failed', {
        ...siteRefForLog(effectiveSite?.site_hash || guestSiteKey, req),
        generation_request_id: generationRequestId
      });
    }

    return res.json({
      success: true,
      title: result.title,
      meta: result.meta,
      credits_used: trialAfter.credits_used,
      credits_remaining: trialAfter.credits_remaining,
      credits_total: trialAfter.credits_total,
      usage: result.usage || null,
      meta_info: result.meta_info || null,
      ...trialAfter,
      entitlement_state: buildEntitlementState(trialAfter, { isLoggedIn: false, isTrial: true }),
      trial_generation: buildTrialGenerationForSingleRequest({
        outcome: 'success',
        trialLimit: trialAfter.trial_limit,
        trialUsedBefore: trialBefore.trial_used,
        trialRemainingBefore: trialBefore.trial_remaining,
        trialUsedAfter: trialAfter.trial_used,
        trialRemainingAfter: trialAfter.trial_remaining
      }),
      generation_request_id: generationRequestId,
      finalize_status: finalizeResult?.data?.status || null
    });
  } catch (error) {
    // A failed generation releases the try, as on the Alt Text guest path.
    await finalizeTitleGenerationQuota(supabase, {
      generationRequestId,
      success: false,
      finalMetadata: {
        guest: true,
        guest_site_key: guestSiteKey,
        error_message: error.message || 'Generation failed',
        error_code: error.code || 'GENERATION_FAILED'
      }
    });

    const status = error.httpStatus
      || (error.code === 'BACKEND_CONFIG_ERROR' ? 500
        : error.code === 'UPSTREAM_RATE_LIMITED' ? 429
          : 502);

    return res.status(status).json({
      success: false,
      error: error.code || 'GENERATION_FAILED',
      code: error.code || 'GENERATION_FAILED',
      message: error.message || 'Title generation failed',
      retryable: Boolean(error.isRetryable)
    });
  }
}

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

    // Signed-out site: the auth middleware only sets trialMode when no
    // licence, API key or bearer token came with the request.
    if (req.trialMode) {
      return handleGuestGenerate(req, res, { supabase, checkRateLimit, page, options, previous });
    }

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

    if (isAutopilotRequest(req)) {
      const planStatus = await getTitleQuotaStatus(supabase, {
        account: resolveAccount(req),
        licenseKey,
        siteIdentity,
        requestId: req.id || null
      }).catch((error) => ({ error: error?.code || 'PLAN_LOOKUP_FAILED' }));
      if (await refuseFreeAutopilot(req, res, { status: planStatus, route: 'titles_generate' })) return;
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
        endpoint: TITLES_GENERATE_ENDPOINT,
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

    if (await refuseFreeAutopilot(req, res, { status, route: 'titles_jobs' })) return;

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
      has_site_key: siteKey !== 'default'
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

module.exports = { createTitlesRouter, TITLES_AUTOPILOT_SOURCE };
