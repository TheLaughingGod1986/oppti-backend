const express = require('express');
const logger = require('../lib/logger');
const { captureServerEvent } = require('../lib/posthog');

function createAnalyticsRouter({ capture = captureServerEvent } = {}) {
  const router = express.Router();

  router.post('/event', async (req, res) => {
    const account = req.user || req.license || null;
    if (!account) {
      return res.status(401).json({
        error: 'UNAUTHORIZED',
        code: 'UNAUTHORIZED',
        message: 'Authentication required'
      });
    }

    const event = typeof req.body?.event === 'string' ? req.body.event.trim() : '';
    const properties = req.body?.properties;
    if (!event || (properties !== undefined && (!properties || Array.isArray(properties) || typeof properties !== 'object'))) {
      return res.status(400).json({
        error: 'VALIDATION_ERROR',
        code: 'VALIDATION_ERROR',
        message: 'A valid event name and properties object are required'
      });
    }

    const result = await capture({
      event,
      distinctId: account.id,
      properties: {
        ...(properties || {}),
        source: req.body?.source || 'website',
        request_id: req.id || undefined
      }
    });

    if (!result?.ok) {
      const status = result?.skipped ? 503 : 502;
      logger.error('[analytics] event_forward_failed', {
        route: 'analytics.event',
        status,
        upstream_status: result?.status || null,
        auth_state: req.authMethod || 'authenticated',
        request_id: req.id || null
      });
      return res.status(status).json({
        error: result?.skipped ? 'SERVICE_UNAVAILABLE' : 'UPSTREAM_ERROR',
        code: result?.skipped ? 'SERVICE_UNAVAILABLE' : 'UPSTREAM_ERROR',
        message: 'Analytics event could not be recorded'
      });
    }

    logger.info('[analytics] event_forwarded', {
      route: 'analytics.event',
      status: 200,
      upstream_status: result.status || 200,
      auth_state: req.authMethod || 'authenticated',
      request_id: req.id || null
    });
    return res.json({ ok: true });
  });

  return router;
}

module.exports = { createAnalyticsRouter };
