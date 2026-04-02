const express = require('express');
const { z } = require('zod');
const logger = require('../lib/logger');
const { reviewAltText } = require('../lib/openai');
const { validateImagePayload } = require('../lib/validation');

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

function createReviewRouter() {
  const router = express.Router();

  router.post('/', async (req, res) => {
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
