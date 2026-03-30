const express = require('express');
const crypto = require('crypto');
const { z } = require('zod');
const { validateImagePayload } = require('../lib/validation');
const { generateAltText } = require('../lib/openai');
const {
  finalizeGenerationQuotaReservation,
  getQuotaStatus,
  reserveGenerationQuota
} = require('../services/quota');
const { recordUsage } = require('../services/usage');
const { findOrCreateTrialSite } = require('../services/site');
const { buildSiteIdentity } = require('../lib/siteIdentity');
const { hashRequestFingerprint } = require('../services/siteQuota');
const { extractUserInfo } = require('../middleware/auth');

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
  regenerate
}) {
  return hashRequestFingerprint({
    site_hash: siteIdentity.siteHash || null,
    wp_install_uuid: siteIdentity.wpInstallUuid || null,
    user_id: userInfo.user_id || null,
    user_email: userInfo.user_email || null,
    filename: normalizedImage.filename || null,
    url: normalizedImage.url || null,
    image_hash: normalizedImage.base64
      ? crypto.createHash('sha256').update(normalizedImage.base64).digest('hex')
      : null,
    context: context || {},
    regenerate: Boolean(regenerate)
  });
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
    const logger = require('../lib/logger');
    
    // Log request for debugging
    logger.info('[altText] Request validation', {
      hasBody: !!req.body,
      bodyKeys: req.body ? Object.keys(req.body) : [],
      hasImage: !!(req.body?.image),
      imageKeys: req.body?.image ? Object.keys(req.body.image) : [],
      hasBase64: !!(req.body?.image?.base64 || req.body?.image?.image_base64),
      hasUrl: !!req.body?.image?.url,
      hasContext: !!req.body?.context
    });
    
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
    const siteIdentity = buildSiteIdentity({
      siteHash: req.trialMode ? req.trialSiteHash : (req.header('X-Site-Key') || req.header('X-Site-Hash') || 'default'),
      installUuid: req.trialMode ? req.trialSiteHash : (req.header('X-Site-Key') || req.header('X-Site-Hash') || req.body?.site_id || req.body?.siteId || null),
      siteUrl: req.header('X-Site-URL') || req.body?.trial_site_url || req.body?.site_url || null,
      siteFingerprint: req.header('X-Site-Fingerprint') || req.body?.site_fingerprint || null
    });
    if (siteIdentity.error === 'DEVELOPMENT_SITE_NOT_ALLOWED') {
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

    // Rate limit per site/license
    if (!(await checkRateLimit(`${siteKey}:${req.ip || 'unknown-ip'}`))) {
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

    // Enhanced logging for debugging
    logger.info('[altText] Request received', {
      hasBase64: !!(image.base64 || image.image_base64),
      hasUrl: !!image.url,
      imageSource: normalizedBase64 ? 'base64' : (normalized.url ? 'url' : 'none'),
      rawBase64Preview: (image.base64 || image.image_base64 || '').substring(0, 100) + '...',
      normalizedBase64Preview: normalizedBase64 ? normalizedBase64.substring(0, 100) + '...' : null,
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
        try {
          const quotaStatus = await getQuotaStatus(supabase, {
            account: req.user || req.license || null,
            licenseKey,
            siteHash: siteIdentity.siteHash,
            siteUrl: siteIdentity.siteUrl,
            siteFingerprint: siteIdentity.siteFingerprint,
            installUuid: siteIdentity.wpInstallUuid,
            requestId: req.id || null
          });
          if (!quotaStatus.error) {
            creditsInfo = {
              credits_used: quotaStatus.credits_used,
              credits_remaining: quotaStatus.credits_remaining,
              limit: quotaStatus.total_limit
            };
            logger.info('[altText] Quota status fetched for cached response', creditsInfo);
          }
        } catch (err) {
          logger.warn('[altText] Failed to fetch quota for cached response', { error: err.message });
        }

        return res.json({ ...cachedData, ...creditsInfo, cached: true });
      }
    } else if (bypassCache) {
      logger.info('[altText] Cache bypassed', { reason: regenerate ? 'regenerate flag' : 'explicit bypass' });
    }

    if (req.trialMode) {
      findOrCreateTrialSite(supabase, {
        siteHash: siteIdentity.siteHash,
        siteUrl: siteIdentity.siteUrl,
        fingerprint: siteIdentity.siteFingerprint
      }).catch(err => {
        logger.warn('[altText] Trial site upsert failed (non-blocking)', { error: err.message });
      });
    }

    const idempotencyKey = extractIdempotencyKey(req);
    const requestFingerprint = buildGenerationFingerprint({
      siteIdentity,
      normalizedImage: normalized,
      context,
      userInfo,
      regenerate
    });

    const quotaMetadata = {
      request_id: req.id || null,
      endpoint: 'api/alt-text',
      image_filename: normalized.filename || null,
      image_url: normalized.url || null,
      plugin_version: userInfo.plugin_version || null,
      wp_user_id: userInfo.user_id || null,
      wp_user_email: userInfo.user_email || null
    };

    const reservation = await reserveGenerationQuota(supabase, {
      account: req.user || req.license || null,
      licenseKey,
      siteHash: siteIdentity.siteHash,
      siteUrl: siteIdentity.siteUrl,
      siteFingerprint: siteIdentity.siteFingerprint,
      installUuid: siteIdentity.wpInstallUuid,
      creditsNeeded: 1,
      quotaMode: req.trialMode ? 'trial' : 'site',
      idempotencyKey,
      requestFingerprint,
      requestMetadata: quotaMetadata,
      requestId: req.id || null
    });

    if (reservation.error) {
      return res.status(reservation.status || 402).json({
        error: reservation.error,
        message: reservation.message || 'Quota exceeded',
        code: reservation.error,
        credits_used: reservation.payload?.credits_used,
        total_limit: reservation.payload?.total_limit,
        reset_date: reservation.payload?.quota_period_end || reservation.payload?.reset_date,
        remaining: reservation.payload?.remaining_credits
      });
    }

    logger.info('[altText] Calling OpenAI to generate alt text');
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
      await finalizeGenerationQuotaReservation(supabase, {
        generationRequestId: reservation.reservation?.generation_request_id || null,
        success: false,
        finalMetadata: {
          error_message: error.message,
          request_id: req.id || null
        }
      });
      logger.error('[altText] Alt text generation failed', {
        error: error.message,
        requestId: req.id || null,
        siteHash: siteKey
      });
      return res.status(500).json({
        error: 'GENERATION_FAILED',
        message: 'Failed to generate alt text'
      });
    }
    
    logger.info('[altText] Alt text generated', {
      altText,
      altTextLength: altText ? altText.length : 0,
      generationTimeMs: generationTime,
      modelUsed: meta?.modelUsed,
      tokensUsed: usage?.total_tokens
    });

    await finalizeGenerationQuotaReservation(supabase, {
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
        prompt_tokens: usage?.prompt_tokens || null,
        completion_tokens: usage?.completion_tokens || null,
        total_tokens: usage?.total_tokens || null,
        model_used: meta?.modelUsed || null,
        generation_time_ms: meta?.generation_time_ms || null,
        image_filename: normalized.filename || null
      };
      logger.info('[altText] Recording trial usage', { site_hash: trialPayload.site_hash });
      const { error } = await supabase.from('trial_usage').insert(trialPayload);
      if (error) {
        logger.error('[altText] Failed to record trial usage', { error: error.message, code: error.code });
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
      logger.error('[altText] Failed to record usage', { error: usageResult.error });
    } else {
      logger.info('[altText] Usage recorded successfully');
    }

    // Get updated quota status to return accurate credits_remaining
    let creditsRemaining = null;
    let totalLimit = null;
    let creditsUsed = 1;
    await new Promise(resolve => setTimeout(resolve, 50));

    const quotaStatus = await getQuotaStatus(supabase, {
      account: req.user || req.license || null,
      licenseKey: effectiveLicenseKey,
      siteHash: effectiveSite?.site_hash || siteIdentity.siteHash,
      siteUrl: effectiveSite?.site_url || siteIdentity.siteUrl,
      siteFingerprint: effectiveSite?.site_fingerprint || effectiveSite?.fingerprint || siteIdentity.siteFingerprint,
      installUuid: effectiveSite?.wp_install_uuid || siteIdentity.wpInstallUuid,
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

    if (cacheKey && !bypassCache) {
      const payload = { altText, warnings, usage, meta };
      if (redis) {
        redis.set(`alttext:cache:${cacheKey}`, JSON.stringify(payload), 'EX', 60 * 60 * 24 * 7).catch(() => {});
      } else {
        resultCache.set(cacheKey, payload);
      }
    }

    const response = {
      altText,
      credits_used: creditsUsed,
      credits_remaining: creditsRemaining !== null ? creditsRemaining : undefined,
      limit: totalLimit !== null ? totalLimit : undefined,
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
    
    // Log the response being sent
    logger.info('[altText] Sending response with credits', {
      credits_used: response.credits_used,
      credits_remaining: response.credits_remaining,
      limit: response.limit,
      has_altText: !!response.altText
    });
    
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
