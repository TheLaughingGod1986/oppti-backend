const express = require('express');
const crypto = require('crypto');
const { z } = require('zod');
const { validateImagePayload } = require('../lib/validation');
const { generateAltText } = require('../lib/openai');
const { enforceQuota } = require('../services/quota');
const { recordUsage } = require('../services/usage');
const { extractUserInfo } = require('../middleware/auth');

function hashPayload(base64) {
  return crypto.createHash('md5').update(base64).digest('hex');
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
    const siteKey = req.header('X-Site-Key') || 'default';
    // Get license key from header OR from JWT-authenticated user
    const licenseKey = req.header('X-License-Key') || req.license?.license_key;
    const userInfo = extractUserInfo(req);
    // Support regenerate flag in body or query, plus cache bypass headers
    const regenerate = req.body.regenerate === true || req.query.regenerate === 'true' || req.query.regenerate === '1';
    const bypassCache = regenerate || req.header('X-Bypass-Cache') === 'true' || req.query.no_cache === '1';

    // Quota enforcement
    try {
      await enforceQuota(supabase, { licenseKey, siteHash: siteKey, creditsNeeded: 1 });
    } catch (err) {
      return res.status(err.status || 402).json({
        error: err.code || 'QUOTA_EXCEEDED',
        message: err.message,
        code: err.code || 'QUOTA_EXCEEDED',
        credits_used: err.payload?.credits_used,
        total_limit: err.payload?.total_limit,
        reset_date: err.payload?.reset_date
      });
    }

    // Rate limit per site/license
    if (!(await checkRateLimit(siteKey))) {
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
        const { getQuotaStatus } = require('../services/quota');
        let creditsInfo = {};
        try {
          const quotaStatus = await getQuotaStatus(supabase, { licenseKey, siteHash: siteKey });
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

    logger.info('[altText] Calling OpenAI to generate alt text');
    const startTime = Date.now();
    const { altText, usage, meta } = await generateAltText({
      image: normalized,
      context: { ...context, filename: normalized.filename }
    });
    const generationTime = Date.now() - startTime;
    
    logger.info('[altText] Alt text generated', {
      altText,
      altTextLength: altText ? altText.length : 0,
      generationTimeMs: generationTime,
      modelUsed: meta?.modelUsed,
      tokensUsed: usage?.total_tokens
    });

    // Record usage/credits
    logger.info('[altText] Recording usage', {
      licenseKey: licenseKey ? `${licenseKey.substring(0, 8)}...` : 'missing',
      siteKey,
      userId: userInfo.user_id,
      creditsUsed: 1
    });
    
    const usageResult = await recordUsage(supabase, {
      licenseKey,
      siteHash: siteKey,
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
    
    if (usageResult.error) {
      logger.error('[altText] Failed to record usage', { error: usageResult.error });
    } else {
      logger.info('[altText] Usage recorded successfully');
    }

    // Get updated quota status to return accurate credits_remaining
    // This ensures the frontend gets the correct remaining credits after usage was recorded
    const { getQuotaStatus } = require('../services/quota');
    let creditsRemaining = null;
    let totalLimit = null;
    let creditsUsed = 1; // Default to 1 since we just used 1 credit
    
    try {
      const quotaStatus = await getQuotaStatus(supabase, { licenseKey, siteHash: siteKey });
      if (!quotaStatus.error) {
        creditsRemaining = quotaStatus.credits_remaining;
        totalLimit = quotaStatus.total_limit;
        creditsUsed = quotaStatus.credits_used;
        logger.info('[altText] Quota status fetched after usage', {
          credits_remaining: creditsRemaining,
          total_limit: totalLimit,
          credits_used: creditsUsed,
          licenseKey: licenseKey ? `${licenseKey.substring(0, 8)}...` : 'missing',
          siteKey
        });
      } else {
        logger.warn('[altText] Failed to fetch quota status', { 
          error: quotaStatus.error,
          message: quotaStatus.message,
          licenseKey: licenseKey ? `${licenseKey.substring(0, 8)}...` : 'missing'
        });
        // Fallback: calculate remaining from limit if we have it
        if (totalLimit === null) {
          // Try to get limit from license
          const { data: license } = await supabase
            .from('licenses')
            .select('plan')
            .eq('license_key', licenseKey)
            .single();
          if (license) {
            const { getLimits } = require('../services/license');
            const limits = getLimits(license.plan);
            totalLimit = limits.credits;
            creditsRemaining = Math.max(totalLimit - creditsUsed, 0);
            logger.info('[altText] Calculated credits from license plan', {
              plan: license.plan,
              total_limit: totalLimit,
              credits_remaining: creditsRemaining
            });
          }
        }
      }
    } catch (err) {
      logger.error('[altText] Error fetching quota status', { 
        error: err.message,
        stack: err.stack,
        licenseKey: licenseKey ? `${licenseKey.substring(0, 8)}...` : 'missing'
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

    // Simple admin key check (use env var in production)
    if (adminKey !== process.env.ADMIN_KEY && adminKey !== 'flush-cache-2026') {
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
