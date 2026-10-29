const crypto = require('node:crypto');
const { installIdFromSiteKey } = require('./installId');
/** Explicit opt-in travels separately from credentials; never infer consent from auth. */
function pluginTelemetryContext(req, { pluginSlug, product, operationId }) {
  if (req.header('X-Telemetry-Consent') !== 'yes') return null;
  const install = req.header('X-Telemetry-Install-ID');
  // Random installation identifiers only. Never accept URLs, email, or auth keys as identity fallback.
  if (typeof install !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(install)) return null;
  // The plugin sends its raw site key here; only the hashed install id leaves.
  const installId = installIdFromSiteKey(install);
  const environment = req.header('X-Environment');
  const account = req.user?.id || req.license?.id;
  return {
    plugin_slug: pluginSlug, product,
    site_install_id: installId, journey_id: installId,
    ...(account ? { account_id: 'acct_' + crypto.createHash('sha256').update(String(account)).digest('hex').slice(0, 32) } : {}),
    environment: ['production', 'staging', 'development', 'local', 'test'].includes(environment) ? environment : 'unknown',
    telemetry_consent: true,
    is_test: req.header('X-Telemetry-Test') === 'yes' || environment !== 'production',
    telemetry_source: 'backend', telemetry_schema: 'opptiai_usage_v2',
    operation_id: operationId,
    // No claim that a server request proves a human customer action.
    traffic_origin: 'server_request',
  };
}
module.exports = { pluginTelemetryContext };
