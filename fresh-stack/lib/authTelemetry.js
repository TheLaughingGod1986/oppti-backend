const crypto = require('crypto');
const logger = require('./logger');
const { captureServerEvent, EVENT_SCHEMA_VERSION } = require('./posthog');
const CORRELATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;

const AUTH_ERRORS = Object.freeze({
  invalid_credentials: { category: 'authentication', stage: 'credential_verification', retryable: false, status: 401 },
  account_not_found: { category: 'authentication', stage: 'credential_verification', retryable: false, status: 401 },
  account_disabled: { category: 'account_state', stage: 'account_check', retryable: false, status: 403 },
  email_not_verified: { category: 'account_state', stage: 'account_check', retryable: false, status: 403 },
  rate_limited: { category: 'user_input', stage: 'backend_validation', retryable: true, status: 429 },
  validation_failed: { category: 'user_input', stage: 'backend_validation', retryable: false, status: 400 },
  network_timeout: { category: 'network', stage: 'network_request', retryable: true, status: 504 },
  network_unavailable: { category: 'network', stage: 'network_request', retryable: true, status: 503 },
  api_unavailable: { category: 'upstream_service', stage: 'credential_verification', retryable: true, status: 503 },
  server_error: { category: 'server', stage: 'unknown', retryable: true, status: 500 },
  malformed_response: { category: 'upstream_service', stage: 'response_parsing', retryable: true, status: 502 },
  token_creation_failed: { category: 'session', stage: 'token_creation', retryable: true, status: 500 },
  token_invalid: { category: 'authentication', stage: 'token_creation', retryable: false, status: 401 },
  token_expired: { category: 'authentication', stage: 'token_creation', retryable: false, status: 401 },
  session_creation_failed: { category: 'session', stage: 'session_creation', retryable: true, status: 500 },
  unknown_auth_error: { category: 'unknown', stage: 'unknown', retryable: false, status: 500 }
});

function normalizeCorrelationId(value) {
  const candidate = Array.isArray(value) ? value[0] : value;
  return typeof candidate === 'string' && CORRELATION_ID_PATTERN.test(candidate)
    ? candidate
    : crypto.randomUUID();
}

function getCorrelationId(req) {
  if (req.correlationId) return req.correlationId;
  req.correlationId = normalizeCorrelationId(req.header?.('X-Correlation-ID'));
  return req.correlationId;
}

function getErrorDefinition(errorCode) {
  return AUTH_ERRORS[errorCode] || AUTH_ERRORS.unknown_auth_error;
}

function buildAuthProperties(req, overrides = {}) {
  const correlationId = getCorrelationId(req);
  const definition = overrides.error_code ? getErrorDefinition(overrides.error_code) : null;
  return {
    correlation_id: correlationId,
    environment: process.env.NODE_ENV || 'development',
    is_internal: false,
    plugin_version: req.body?.plugin_version || null,
    site_install_id: req.body?.install_uuid || req.body?.site_id || null,
    anonymous_distinct_id: req.body?.anon_id || null,
    auth_method: 'password',
    error_code: overrides.error_code || null,
    error_category: overrides.error_category || definition?.category || null,
    failure_stage: overrides.failure_stage || definition?.stage || null,
    http_status: overrides.http_status ?? definition?.status ?? null,
    retryable: overrides.retryable ?? definition?.retryable ?? null,
    request_duration_ms: overrides.request_duration_ms ?? null,
    backend_request_id: req.id || null,
    event_schema_version: EVENT_SCHEMA_VERSION,
    ...overrides
  };
}

async function captureAuthEvent({ req, event, distinctId, properties = {} }) {
  try {
    return await captureServerEvent({
      event,
      distinctId: distinctId || req.body?.anon_id || getCorrelationId(req),
      properties: buildAuthProperties(req, properties)
    });
  } catch (error) {
    logger.warn('[auth] analytics_capture_failed', {
      service: 'oppti-backend',
      environment: process.env.NODE_ENV || 'development',
      correlation_id: getCorrelationId(req),
      request_id: req.id || null,
      operation: event,
      result: 'analytics_failed',
      error_code: 'api_unavailable',
      failure_stage: 'response_parsing',
      retryable: true
    });
    return { ok: false, error };
  }
}

function authLog(level, req, {
  operation,
  result,
  errorCode = null,
  failureStage = null,
  retryable = null,
  durationMs = null,
  ...extra
}) {
  const definition = errorCode ? getErrorDefinition(errorCode) : null;
  logger[level]('[auth]', {
    timestamp: new Date().toISOString(),
    level,
    service: 'oppti-backend',
    environment: process.env.NODE_ENV || 'development',
    correlation_id: getCorrelationId(req),
    request_id: req.id || null,
    operation,
    result,
    error_code: errorCode,
    failure_stage: failureStage || definition?.stage || null,
    retryable: retryable ?? definition?.retryable ?? null,
    duration_ms: durationMs,
    ...extra
  });
}

module.exports = {
  AUTH_ERRORS,
  EVENT_SCHEMA_VERSION,
  authLog,
  buildAuthProperties,
  captureAuthEvent,
  getCorrelationId,
  getErrorDefinition,
  normalizeCorrelationId
};
