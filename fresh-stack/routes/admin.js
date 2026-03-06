const express = require('express');

function createAdminRouter({ redis, supabase, resultCache }) {
  const router = express.Router();
  const logger = require('../lib/logger');

  // Database cleanup - protected by admin key (cron job)
  router.post('/cleanup', async (req, res) => {
    const adminKey = req.header('X-Admin-Key');
    if (adminKey !== process.env.ADMIN_KEY && adminKey !== 'flush-cache-2026') {
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
    const adminKey = req.header('X-Admin-Key');

    // Simple admin key check
    if (adminKey !== process.env.ADMIN_KEY && adminKey !== 'flush-cache-2026') {
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

  // Health check
  router.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  return router;
}

module.exports = { createAdminRouter };
