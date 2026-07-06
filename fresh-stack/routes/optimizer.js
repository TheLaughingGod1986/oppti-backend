const express = require('express');
const { z } = require('zod');
const logger = require('../lib/logger');
const {
  startOptimizerAudit,
  getOptimizerAudit,
  getOptimizerHistory
} = require('../services/optimizerAudit');
const { getOptimizerProgress } = require('../services/optimizerProgress');

/**
 * Oppti Optimizer plugin API.
 *
 * POST /api/optimizer/audit      — start a site audit (authed: license, JWT or
 *                                  anonymous trial via X-Site-Hash, same rails
 *                                  as the alt-text plugin).
 * GET  /api/optimizer/audit/:id  — poll status/results. Public by UUID, same
 *                                  model as GET /api/jobs/:id.
 * GET  /api/optimizer/history    — completed audits for the requesting site
 *                                  (same auth rails as audit start).
 */
function createOptimizerRouter({ supabase = null } = {}) {
  const router = express.Router();

  // Per-site crawl throttle — crawling is the expensive bit.
  const rateLimitMap = new Map();
  const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
  const RATE_LIMIT_MAX = Number(process.env.OPTIMIZER_AUDIT_RATE_LIMIT_MAX || 10);

  function checkRateLimit(key) {
    const now = Date.now();
    const windowStart = now - RATE_LIMIT_WINDOW_MS;
    const timestamps = (rateLimitMap.get(key) || []).filter((ts) => ts >= windowStart);
    if (timestamps.length >= RATE_LIMIT_MAX) return false;
    timestamps.push(now);
    rateLimitMap.set(key, timestamps);
    return true;
  }

  const schema = z.object({
    siteUrl: z.string().min(1).optional()
  });

  router.post('/audit', (req, res) => {
    try {
      const parsed = schema.safeParse(req.body || {});
      if (!parsed.success) {
        return res.status(400).json({
          ok: false,
          error: 'VALIDATION_ERROR',
          message: parsed.error.issues[0]?.message || 'Invalid audit request'
        });
      }

      // Site URL comes from the plugin's standard identity headers; an
      // explicit body value wins (dev/testing convenience).
      const siteUrl = parsed.data.siteUrl || req.header('X-Site-URL');
      if (!siteUrl) {
        return res.status(400).json({
          ok: false,
          error: 'SITE_URL_REQUIRED',
          message: 'Provide siteUrl or the X-Site-URL header'
        });
      }

      const siteHash = req.header('X-Site-Hash') || req.header('X-Site-Key') || req.ip || 'unknown';
      if (!checkRateLimit(siteHash)) {
        return res.status(429).json({
          ok: false,
          error: 'RATE_LIMIT_EXCEEDED',
          message: 'Too many audits for this site. Please try again later.',
          retry_after: 3600
        });
      }

      const record = startOptimizerAudit({ siteUrl, siteHash, supabase });
      logger.info('[optimizer] audit started', {
        audit_id: record.auditId,
        site_url: record.siteUrl,
        site_hash: siteHash,
        auth_method: req.authMethod || 'unknown'
      });

      return res.status(202).json({
        ok: true,
        auditId: record.auditId,
        status: record.status
      });
    } catch (error) {
      const status = error.status || 500;
      return res.status(status).json({
        ok: false,
        error: error.code || 'AUDIT_REQUEST_FAILED',
        message: status >= 500 ? 'Unable to start the audit. Please try again.' : error.message
      });
    }
  });

  router.get('/audit/:auditId', async (req, res) => {
    const record = await getOptimizerAudit(req.params.auditId, { supabase });
    if (!record) {
      return res.status(404).json({
        ok: false,
        error: 'AUDIT_NOT_FOUND',
        message: 'Unknown or expired audit id'
      });
    }

    return res.json({
      ok: true,
      auditId: record.auditId,
      status: record.status,
      siteUrl: record.siteUrl,
      startedAt: record.startedAt,
      errorCode: record.errorCode,
      result: record.status === 'completed' ? record.result : null
    });
  });

  router.get('/history', async (req, res) => {
    const siteHash = req.header('X-Site-Hash') || req.header('X-Site-Key');
    if (!siteHash) {
      return res.status(400).json({
        ok: false,
        error: 'SITE_HASH_REQUIRED',
        message: 'Provide the X-Site-Hash header'
      });
    }
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 12));
    const audits = await getOptimizerHistory({ siteHash, supabase, limit });
    return res.json({ ok: true, audits });
  });

  // Progress screen data: weekly report + achievements, computed from audit
  // history and real plugin usage. Same auth rails as audit start.
  router.get('/progress', async (req, res) => {
    const siteHash = req.header('X-Site-Hash') || req.header('X-Site-Key');
    if (!siteHash) {
      return res.status(400).json({
        ok: false,
        error: 'SITE_HASH_REQUIRED',
        message: 'Provide the X-Site-Hash header'
      });
    }
    try {
      const progress = await getOptimizerProgress({ siteHash, supabase });
      return res.json({ ok: true, ...progress });
    } catch (error) {
      logger.warn('[optimizer] progress failed', { site_hash: siteHash, error: error.message });
      return res.status(500).json({ ok: false, error: 'PROGRESS_FAILED', message: 'Unable to load progress' });
    }
  });

  return router;
}

module.exports = {
  createOptimizerRouter
};
