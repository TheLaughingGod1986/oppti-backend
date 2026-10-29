const express = require('express');
const logger = require('../lib/logger');
const { captureServerEvent } = require('../lib/posthog');

// Website events may only carry these properties. Strings are short labels;
// page_path keeps the path only (no query string or fragment). Anything else,
// including emails, keys, URLs and nested objects, is dropped.
const ALLOWED_EVENT_PROPERTIES = Object.freeze([
  'page_path',
  'section',
  'tab',
  'cta',
  'button',
  'plan',
  'target_plan',
  'plugin',
  'billing_interval',
  'step',
  'status',
  'error_code',
  'variant',
  'count',
  'value'
]);
const MAX_PROPERTY_LENGTH = 120;
// Event names are snake_case words: lower-case letter first, then lower-case
// letters, digits or '_', 64 characters at most. This rules out PostHog's
// reserved $ names ($identify, $set, ...) and free text such as an email.
const EVENT_NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

function isValidEventName(name) {
  return typeof name === 'string' && EVENT_NAME_PATTERN.test(name);
}

function sanitizeEventProperties(properties = {}) {
  const out = {};
  for (const key of ALLOWED_EVENT_PROPERTIES) {
    let value = properties[key];
    if (typeof value === 'number' || typeof value === 'boolean') {
      if (typeof value !== 'number' || Number.isFinite(value)) out[key] = value;
      continue;
    }
    if (typeof value !== 'string') continue;
    value = value.trim();
    if (key === 'page_path') {
      value = value.split(/[?#]/)[0];
      if (!value.startsWith('/') || value.startsWith('//')) continue;
    } else if (/[@:/]/.test(value)) {
      // Labels never contain emails, URLs or paths.
      continue;
    }
    if (value.includes('@')) continue;
    if (value) out[key] = value.slice(0, MAX_PROPERTY_LENGTH);
  }
  return out;
}

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

    if (!isValidEventName(event)) {
      // Fixed label only: the rejected name itself is never logged.
      logger.warn('[analytics] rejected_event_name', {
        route: 'analytics.event',
        reason: 'invalid_event_name',
        request_id: req.id || null
      });
      return res.status(400).json({
        error: 'VALIDATION_ERROR',
        code: 'VALIDATION_ERROR',
        message: 'Event names must be lower-case letters, digits or underscores'
      });
    }

    const result = await capture({
      event,
      distinctId: account.id,
      properties: {
        ...sanitizeEventProperties(properties || {}),
        source: req.body?.source === 'app' ? 'app' : 'website',
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

module.exports = { createAnalyticsRouter, sanitizeEventProperties, isValidEventName, ALLOWED_EVENT_PROPERTIES, EVENT_NAME_PATTERN };
