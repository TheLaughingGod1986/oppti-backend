const crypto = require('crypto');
const express = require('express');
const { z } = require('zod');
const logger = require('../lib/logger');
const {
  normalizeAuditUrl,
  normalizeEmail,
  isValidEmail,
  assertPublicUrl,
  runImageSeoAudit,
  getAnonymisedImageSeoSnapshot,
  DEFAULT_PUBLISH_THRESHOLD
} = require('../services/imageSeoAudit');

function createImageSeoAuditRouter({ supabase, runAudit = runImageSeoAudit } = {}) {
  const router = express.Router();
  const rateLimitMap = new Map();
  const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
  const RATE_LIMIT_MAX = Number(process.env.IMAGE_SEO_AUDIT_RATE_LIMIT_MAX || 3);

  const schema = z.object({
    email: z.string().min(1),
    siteUrl: z.string().min(1),
    source: z.string().max(80).optional(),
    consent: z.literal(true)
  });

  function checkRateLimit(key) {
    const now = Date.now();
    const windowStart = now - RATE_LIMIT_WINDOW_MS;
    const timestamps = (rateLimitMap.get(key) || []).filter((ts) => ts >= windowStart);
    if (timestamps.length >= RATE_LIMIT_MAX) return false;
    timestamps.push(now);
    rateLimitMap.set(key, timestamps);
    return true;
  }

  /** Public anonymised aggregates for the State of Image SEO report. No PII. */
  router.get('/stats', async (_req, res) => {
    try {
      const snapshot = await getAnonymisedImageSeoSnapshot(supabase, {
        publishThreshold: DEFAULT_PUBLISH_THRESHOLD
      });
      res.set('Cache-Control', 'public, max-age=300, s-maxage=3600');
      return res.status(200).json({ ok: true, snapshot });
    } catch (error) {
      logger.error('[image-seo-audit] stats failed', { error: error.message });
      return res.status(500).json({
        ok: false,
        error: 'STATS_UNAVAILABLE',
        message: 'Unable to load anonymised audit stats.'
      });
    }
  });

  router.post('/', async (req, res) => {
    const auditId = crypto.randomUUID();

    try {
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          ok: false,
          error: 'VALIDATION_ERROR',
          message: parsed.error.issues[0]?.message || 'Invalid audit request'
        });
      }

      const email = normalizeEmail(parsed.data.email);
      if (!isValidEmail(email)) {
        return res.status(400).json({
          ok: false,
          error: 'EMAIL_INVALID',
          message: 'Enter a valid email address'
        });
      }

      const url = normalizeAuditUrl(parsed.data.siteUrl);
      await assertPublicUrl(url);
      const normalizedDomain = url.hostname.replace(/^www\./, '').toLowerCase();
      const ip = req.ip || req.headers['x-forwarded-for'] || 'unknown';
      const rateLimitKey = `${ip}:${normalizedDomain}`;

      if (!checkRateLimit(rateLimitKey)) {
        return res.status(429).json({
          ok: false,
          error: 'RATE_LIMIT_EXCEEDED',
          message: 'Too many audit requests. Please try again later.',
          retry_after: 3600
        });
      }

      setImmediate(() => {
        runAudit({
          supabase,
          auditId,
          email,
          siteUrl: url.toString(),
          source: parsed.data.source || 'image_seo_audit'
        }).catch((error) => {
          logger.error('[image-seo-audit] background audit failed', {
            audit_id: auditId,
            site_url: url.toString(),
            normalized_domain: normalizedDomain,
            error: error.message,
            code: error.code || null
          });
        });
      });

      return res.status(202).json({
        ok: true,
        auditId,
        status: 'queued'
      });
    } catch (error) {
      const status = error.status || 500;
      logger.warn('[image-seo-audit] request rejected', {
        audit_id: auditId,
        error: error.message,
        code: error.code || null,
        status
      });
      return res.status(status).json({
        ok: false,
        error: error.code || 'AUDIT_REQUEST_FAILED',
        message: status >= 500 ? 'Unable to start the audit. Please try again.' : error.message
      });
    }
  });

  return router;
}

module.exports = {
  createImageSeoAuditRouter
};
