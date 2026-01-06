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
    const parsed = requestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'INVALID_REQUEST', message: 'Invalid payload', details: parsed.error.flatten() });
    }

    const { image, context = {} } = parsed.data;
    const siteKey = req.header('X-Site-Key') || 'default';
    // Get license key from header OR from JWT-authenticated user
    const licenseKey = req.header('X-License-Key') || req.license?.license_key;
    const userInfo = extractUserInfo(req);
    const bypassCache = req.header('X-Bypass-Cache') === 'true' || req.query.no_cache === '1';

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

    // Deduplication via hash
    const base64Data = image.base64 || image.image_base64 || '';
    const cacheKey = base64Data ? hashPayload(base64Data) : null;
    
    // Enhanced logging for debugging
    const logger = require('../lib/logger');
    logger.info('[altText] Request received', {
      hasBase64: !!(image.base64 || image.image_base64),
      hasUrl: !!image.url,
      imageSource: base64Data ? 'base64' : (image.url ? 'url' : 'none'),
      base64Preview: base64Data ? base64Data.substring(0, 100) + '...' : null,
      base64Length: base64Data ? base64Data.length : 0,
      imageUrl: image.url || null,
      dimensions: image.width && image.height ? `${image.width}x${image.height}` : 'unknown',
      filename: image.filename || 'unknown',
      cacheKey: cacheKey ? cacheKey.substring(0, 16) + '...' : null,
      bypassCache,
      regenerate: req.body.regenerate || req.query.regenerate || false
    });
    
    if (cacheKey && !bypassCache) {
      if (redis) {
        try {
          const cached = await redis.get(`alttext:cache:${cacheKey}`);
          if (cached) {
            const parsed = JSON.parse(cached);
            return res.json({ ...parsed, cached: true });
          }
        } catch (e) {
          // ignore cache errors
        }
      } else if (resultCache.has(cacheKey)) {
        const cached = resultCache.get(cacheKey);
        logger.info('[altText] Cache hit', { cacheKey: cacheKey ? cacheKey.substring(0, 16) + '...' : null });
        return res.json({ ...cached, cached: true });
      }
    }

    const { errors, warnings, normalized } = validateImagePayload(image);
    if (errors.length) {
      return res.status(400).json({ error: 'INVALID_REQUEST', errors, warnings });
    }

    logger.info('[altText] Image payload normalized', {
      normalizedHasBase64: !!normalized.base64,
      normalizedHasUrl: !!normalized.url,
      normalizedSource: normalized.base64 ? 'base64' : (normalized.url ? 'url' : 'none'),
      normalizedDimensions: normalized.width && normalized.height ? `${normalized.width}x${normalized.height}` : 'unknown',
      errors: errors.length,
      warnings: warnings.length
    });

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

    if (cacheKey && !bypassCache) {
      const payload = { altText, warnings, usage, meta };
      if (redis) {
        redis.set(`alttext:cache:${cacheKey}`, JSON.stringify(payload), 'EX', 60 * 60 * 24 * 7).catch(() => {});
      } else {
        resultCache.set(cacheKey, payload);
      }
    }

    res.json({
      altText,
      credits_used: 1,
      credits_remaining: usage?.credits_remaining,
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
    });
  });

  return router;
}

module.exports = { createAltTextRouter };
