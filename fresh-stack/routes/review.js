const express = require('express');
const { z } = require('zod');
const logger = require('../lib/logger');
const { reviewAltText } = require('../lib/openai');
const { validateImagePayload } = require('../lib/validation');
const {
  markImageAltStateApproved,
  resolveImageAltStateSiteContext
} = require('../services/imageAltState');

const requestSchema = z.object({
  alt_text: z.string().min(1).optional(),
  altText: z.string().min(1).optional(),
  image_data: z.object({}).passthrough().optional(),
  image: z.object({}).passthrough().optional(),
  context: z.object({}).passthrough().optional(),
  service: z.string().optional()
}).superRefine((data, ctx) => {
  if (!data.alt_text && !data.altText) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'alt_text is required',
      path: ['alt_text']
    });
  }
});

const approveSchema = z.object({
  alt_text: z.string().min(1).optional(),
  altText: z.string().min(1).optional(),
  attachment_id: z.union([z.string(), z.number()]).optional(),
  attachmentId: z.union([z.string(), z.number()]).optional(),
  image_id: z.union([z.string(), z.number()]).optional(),
  imageId: z.union([z.string(), z.number()]).optional(),
  media_id: z.union([z.string(), z.number()]).optional(),
  mediaId: z.union([z.string(), z.number()]).optional(),
  image_url: z.string().optional(),
  imageUrl: z.string().optional(),
  image: z.object({}).passthrough().optional(),
  context: z.object({}).passthrough().optional()
}).superRefine((data, ctx) => {
  const image = data.image || {};
  const context = data.context || {};
  const hasIdentity = Boolean(
    data.attachment_id
      || data.attachmentId
      || data.image_id
      || data.imageId
      || data.media_id
      || data.mediaId
      || data.image_url
      || data.imageUrl
      || image.attachment_id
      || image.attachmentId
      || image.image_id
      || image.imageId
      || image.media_id
      || image.mediaId
      || image.url
      || context.attachment_id
      || context.attachmentId
      || context.image_id
      || context.imageId
      || context.media_id
      || context.mediaId
      || context.image_url
      || context.imageUrl
  );

  if (!hasIdentity) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'image identity is required',
      path: ['image']
    });
  }
});

function normalizeIncomingImage(image = {}) {
  const inlineDataUrl = image.inline?.data_url || image.inline?.dataUrl || null;

  return {
    ...image,
    base64: image.base64 || image.image_base64 || inlineDataUrl || null,
    image_base64: image.image_base64 || image.base64 || inlineDataUrl || null,
    url: image.url || null,
    width: image.width || image.reportedWidth || null,
    height: image.height || image.reportedHeight || null,
    mime_type: image.mime_type || image.mimeType || null,
    filename: image.filename || image.fileName || null
  };
}

function createReviewRouter({ supabase } = {}) {
  const router = express.Router();

  router.post('/approve', async (req, res) => {
    const parsed = approveSchema.safeParse(req.body || {});
    if (!parsed.success) {
      logger.warn('[review] approve validation failed', {
        errors: parsed.error.flatten(),
        bodyPreview: JSON.stringify(req.body || {}).substring(0, 500)
      });
      return res.status(400).json({
        success: false,
        error: 'INVALID_REQUEST',
        message: 'Image identity is required',
        details: parsed.error.flatten()
      });
    }

    if (!supabase) {
      return res.status(500).json({
        success: false,
        error: 'SERVER_ERROR',
        message: 'Review approval storage unavailable'
      });
    }

    const resolved = await resolveImageAltStateSiteContext(supabase, req, {
      createIfMissing: false
    });

    if (resolved.error || !resolved.site?.id) {
      logger.warn('[review] approve site resolution failed', {
        request_id: req.id || null,
        error: resolved.error || 'SITE_NOT_FOUND',
        site_hash: resolved.siteIdentity?.siteHash || null,
        site_url: resolved.siteIdentity?.siteUrl || null
      });
      return res.status(resolved.error === 'INVALID_SITE_IDENTITY' ? 400 : 404).json({
        success: false,
        error: resolved.error || 'SITE_NOT_FOUND',
        message: resolved.error === 'INVALID_SITE_IDENTITY'
          ? 'Valid site identity is required to approve an image state.'
          : 'Canonical site not found for approval request.'
      });
    }

    const image = {
      ...(parsed.data.image || {}),
      attachment_id: parsed.data.attachment_id ?? parsed.data.attachmentId ?? parsed.data.media_id ?? parsed.data.mediaId ?? undefined,
      image_id: parsed.data.image_id ?? parsed.data.imageId ?? undefined,
      url: parsed.data.image_url || parsed.data.imageUrl || parsed.data.image?.url || undefined
    };

    const result = await markImageAltStateApproved(supabase, {
      siteId: resolved.site.id,
      image,
      context: parsed.data.context || {},
      body: parsed.data,
      altText: parsed.data.alt_text ?? parsed.data.altText,
      requestId: req.id || null
    });

    if (result.error) {
      const status = result.error === 'INVALID_IMAGE_IDENTITY' ? 400 : 500;
      logger.error('[review] approve ledger write failed', {
        request_id: req.id || null,
        site_id: resolved.site.id,
        error: result.error?.message || result.error
      });
      return res.status(status).json({
        success: false,
        error: status === 400 ? 'INVALID_IMAGE_IDENTITY' : 'SERVER_ERROR',
        message: status === 400
          ? 'Image identity is required to approve an image state.'
          : 'Failed to persist approved image state.'
      });
    }

    logger.info('[review] approve_state_succeeded', {
      request_id: req.id || null,
      site_id: resolved.site.id,
      site_hash: resolved.site.site_hash || null,
      image_ref: result.data?.image_ref || null
    });

    return res.json({
      success: true,
      data: {
        state: result.data
      }
    });
  });

  router.post('/', async (req, res) => {
    logger.info('[review] post', {
      path: req.path,
      originalUrl: req.originalUrl,
      authMethod: req.authMethod || null
    });
    const parsed = requestSchema.safeParse(req.body || {});
    if (!parsed.success) {
      logger.warn('[review] Schema validation failed', {
        errors: parsed.error.flatten(),
        bodyPreview: JSON.stringify(req.body || {}).substring(0, 500)
      });
      return res.status(400).json({
        error: 'INVALID_REQUEST',
        message: 'Invalid payload - alt_text is required',
        details: parsed.error.flatten()
      });
    }

    const altText = parsed.data.alt_text || parsed.data.altText;
    const rawImage = parsed.data.image_data || parsed.data.image || null;
    let normalizedImage = null;

    if (rawImage && Object.keys(rawImage).length > 0) {
      const { errors, warnings, normalized } = validateImagePayload(normalizeIncomingImage(rawImage));

      if (errors.length) {
        logger.warn('[review] Image validation failed', {
          errors,
          bodyPreview: JSON.stringify(rawImage).substring(0, 500)
        });
        return res.status(400).json({
          error: 'INVALID_REQUEST',
          message: 'Image validation failed',
          errors,
          warnings
        });
      }

      if (warnings.length) {
        logger.warn('[review] Image validation warnings', { warnings });
      }

      normalizedImage = {
        ...normalized,
        title: rawImage.title || null,
        caption: rawImage.caption || null
      };
    } else {
      logger.warn('[review] Request did not include image payload; returning null review for compatibility');
    }

    logger.info('[review] Request received', {
      authMethod: req.authMethod || 'unknown',
      hasImage: Boolean(normalizedImage),
      imageSource: normalizedImage?.base64 ? 'base64' : (normalizedImage?.url ? 'url' : 'none'),
      hasContext: Boolean(parsed.data.context),
      service: parsed.data.service || 'alttext-ai'
    });

    if (!normalizedImage) {
      return res.json({
        success: true,
        review: null,
        tokens: null
      });
    }

    try {
      const review = await reviewAltText({
        altText,
        image: normalizedImage,
        context: parsed.data.context || {},
        service: parsed.data.service || 'alttext-ai'
      });

      return res.json({
        success: true,
        review,
        tokens: review?.usage || null
      });
    } catch (error) {
      logger.error('[review] Review failed', {
        error: error.message,
        code: error.code || 'REVIEW_ERROR'
      });

      return res.status(error.httpStatus || 500).json({
        error: error.code || 'REVIEW_ERROR',
        message: error.message || 'Failed to review alt text',
        code: error.code || 'REVIEW_ERROR'
      });
    }
  });

  return router;
}

module.exports = { createReviewRouter };
