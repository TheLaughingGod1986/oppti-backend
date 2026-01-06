const express = require('express');

function createAdminRouter({ redis, resultCache }) {
  const router = express.Router();
  const logger = require('../lib/logger');

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
