const express = require('express');
const logger = require('../lib/logger');
const { getPipelineDiagnostics } = require('../services/v2Diagnostics');
const { buildDataIntegrityDiagnostics } = require('../services/dataIntegrityDiagnostics');

function hasValidAdminKey(adminKey) {
  const expectedAdminKey = process.env.ADMIN_KEY || process.env.ADMIN_SECRET;
  return Boolean(expectedAdminKey && adminKey && adminKey === expectedAdminKey);
}

function getAdminKey(req) {
  return req.header('X-Admin-Key') || req.header('X-Admin-Secret');
}

function createAdminRouter({ redis, supabase, resultCache, runtimeIdentityProvider = null }) {
  const router = express.Router();

  // Database cleanup - protected by admin key (cron job)
  router.post('/cleanup', async (req, res) => {
    const adminKey = getAdminKey(req);
    if (!hasValidAdminKey(adminKey)) {
      return res.status(401).json({ error: 'Unauthorized', message: 'Invalid admin key' });
    }
    if (!supabase) {
      return res.status(503).json({ error: 'Supabase not available' });
    }
    try {
      const now = new Date();
      const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      const ninetyDaysAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
      let sessionsDeleted = 0;
      let logsDeleted = 0;

      const { data: sessions, error: sessionsErr } = await supabase
        .from('dashboard_sessions')
        .delete()
        .lt('expires_at', sevenDaysAgo.toISOString())
        .select('id');
      if (!sessionsErr && sessions) sessionsDeleted = sessions.length;

      const { data: logs, error: logsErr } = await supabase
        .from('debug_logs')
        .delete()
        .lt('created_at', ninetyDaysAgo.toISOString())
        .select('id');
      if (!logsErr && logs) logsDeleted = logs.length;

      logger.info('[admin] Cleanup completed', { sessionsDeleted, logsDeleted });
      res.json({ success: true, sessionsDeleted, logsDeleted });
    } catch (err) {
      logger.error('[admin] Cleanup failed', { error: err.message });
      res.status(500).json({ error: 'Cleanup failed', message: err.message });
    }
  });

  // Flush alt text cache - protected by admin key only (no license required)
  router.post('/flush-cache', async (req, res) => {
    const adminKey = getAdminKey(req);

    if (!hasValidAdminKey(adminKey)) {
      return res.status(401).json({ error: 'Unauthorized', message: 'Invalid admin key' });
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
        logger.info('[admin] Redis cache flushed', { keysDeleted: flushed });
      } else if (resultCache) {
        // Clear in-memory cache
        flushed = resultCache.size;
        resultCache.clear();
        logger.info('[admin] In-memory cache flushed', { keysDeleted: flushed });
      }

      res.json({
        success: true,
        message: 'Cache flushed successfully',
        keysDeleted: flushed
      });
    } catch (err) {
      logger.error('[admin] Failed to flush cache', { error: err.message });
      res.status(500).json({ error: 'Failed to flush cache', message: err.message });
    }
  });

  router.get('/diagnostics/pipeline', async (req, res) => {
    const adminKey = getAdminKey(req);
    if (!hasValidAdminKey(adminKey)) {
      return res.status(401).json({ error: 'Unauthorized', message: 'Invalid admin key' });
    }

    try {
      const diagnostics = await getPipelineDiagnostics(supabase, { days: 7 });
      return res.json({
        success: true,
        diagnostics
      });
    } catch (error) {
      logger.error('[admin] Pipeline diagnostics failed', {
        error: error.message
      });
      return res.status(500).json({
        success: false,
        error: 'DIAGNOSTICS_FAILED',
        message: error.message
      });
    }
  });

  router.get('/diagnostics/data-integrity', async (req, res) => {
    const adminKey = getAdminKey(req);
    if (!hasValidAdminKey(adminKey)) {
      return res.status(401).json({ error: 'Unauthorized', message: 'Invalid admin key' });
    }

    try {
      const diagnostics = await buildDataIntegrityDiagnostics(supabase, {
        days: 7,
        runtimeIdentity: typeof runtimeIdentityProvider === 'function'
          ? runtimeIdentityProvider()
          : null
      });
      return res.json({
        success: true,
        diagnostics
      });
    } catch (error) {
      logger.error('[admin] Data integrity diagnostics failed', {
        error: error.message
      });
      return res.status(500).json({
        success: false,
        error: 'DATA_INTEGRITY_DIAGNOSTICS_FAILED',
        message: error.message
      });
    }
  });

  // Health check
  router.get('/health', (req, res) => {
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      runtime: typeof runtimeIdentityProvider === 'function'
        ? runtimeIdentityProvider()
        : null
    });
  });

  return router;
}

module.exports = { createAdminRouter };
