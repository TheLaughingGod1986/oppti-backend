const { isInternalTelemetryHost } = require('./siteIdentity');
const packageJson = require('../../package.json');

const EVENT_SCHEMA_VERSION = 2;
const ENVIRONMENTS = new Set(['production', 'staging', 'local', 'test']);
const GENERATION_MODES = new Set(['single', 'bulk', 'regeneration', 'automatic', 'unknown']);

function getPostHogConfig() {
  const apiKey = process.env.POSTHOG_API_KEY;
  const host = process.env.POSTHOG_HOST;

  return {
    apiKey,
    host: host ? host.replace(/\/+$/, '') : null
  };
}

function normalizeEnvironment(value = process.env.APP_ENV || process.env.NODE_ENV) {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (normalized === 'development' || normalized === 'dev') return 'local';
  if (normalized === 'testing') return 'test';
  return ENVIRONMENTS.has(normalized) ? normalized : 'local';
}

function normalizeGenerationMode(value) {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (GENERATION_MODES.has(normalized)) return normalized;
  if (normalizeEnvironment() !== 'production' && normalized) {
    console.warn(`[analytics] invalid generation_mode "${normalized}", using "unknown"`);
  }
  return 'unknown';
}

function withWebsitePersonProperties(properties = {}) {
  const domain = typeof properties.domain === 'string' ? properties.domain.trim() : '';
  if (!domain) return properties;

  return {
    ...properties,
    $set: {
      name: domain,
      website: properties.site_url || domain,
      ...(properties.$set || {})
    }
  };
}

const SENSITIVE_PROPERTY_PATTERN = /(password|passphrase|authorization|cookie|api[_-]?key|access[_-]?token|refresh[_-]?token|session[_-]?token|secret|email|card|payment[_-]?method|raw[_-]?response|image[_-]?(base64|content|data))/i;

function sanitizePostHogProperties(properties = {}) {
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) return {};
  return Object.fromEntries(
    Object.entries(properties)
      .filter(([key]) => !SENSITIVE_PROPERTY_PATTERN.test(key))
      .map(([key, value]) => [
        key,
        value && typeof value === 'object' && !Array.isArray(value)
          ? sanitizePostHogProperties(value)
          : value
      ])
  );
}

function buildCommonProperties(properties = {}) {
  const safe = sanitizePostHogProperties(properties);
  const environment = normalizeEnvironment(safe.environment);
  const siteUrl = safe.site_url || safe.domain || null;
  const configuredInternal = String(process.env.ANALYTICS_INTERNAL || '').toLowerCase() === 'true';

  return {
    ...safe,
    environment,
    is_internal: Boolean(
      safe.is_internal === true
      || configuredInternal
      || isInternalTelemetryHost({ siteUrl })
      || environment === 'local'
      || environment === 'test'
    ),
    plugin_version: safe.plugin_version || null,
    app_version: safe.app_version || packageJson.version || null,
    site_install_id: safe.site_install_id || safe.install_hash || safe.site_id || null,
    session_id: safe.session_id || null,
    correlation_id: safe.correlation_id || safe.request_id || null,
    event_schema_version: EVENT_SCHEMA_VERSION
  };
}

async function sendPostHogRequest({ path, payload }) {
  const { apiKey, host } = getPostHogConfig();

  if (!apiKey || !host || !path || !payload) {
    return { ok: false, skipped: true };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2000);

  try {
    const response = await fetch(`${host}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        api_key: apiKey,
        ...payload
      }),
      signal: controller.signal
    });

    return {
      ok: response.ok,
      status: response.status
    };
  } catch (error) {
    return {
      ok: false,
      error
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function captureServerEvent({ event, distinctId, properties = {} }) {
  if (!event || !distinctId) {
    return { ok: false, skipped: true };
  }

  const commonProperties = buildCommonProperties(properties);

  return sendPostHogRequest({
    path: '/capture/',
    payload: {
      event,
      distinct_id: distinctId,
      properties: sanitizePostHogProperties(withWebsitePersonProperties(commonProperties))
    }
  });
}

async function identifyServerUser({ distinctId, properties = {} }) {
  if (!distinctId) {
    return { ok: false, skipped: true };
  }

  return sendPostHogRequest({
    path: '/identify/',
    payload: {
      distinct_id: distinctId,
      properties: sanitizePostHogProperties(properties)
    }
  });
}

module.exports = {
  captureServerEvent,
  identifyServerUser,
  getPostHogConfig,
  sanitizePostHogProperties,
  withWebsitePersonProperties,
  buildCommonProperties,
  normalizeEnvironment,
  normalizeGenerationMode,
  EVENT_SCHEMA_VERSION,
  GENERATION_MODES
};
