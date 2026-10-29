/**
 * The analytics install id for a site.
 *
 * site_install_id = sha256("oppti-install-v1:" + raw site key), lowercase hex.
 * This is the same formula the plugins use, so backend and plugin events join.
 * The backend is the only hasher for what it emits: callers pass the RAW site
 * key (X-Site-Key, X-Telemetry-Install-ID) or a stored site_hash, which equals
 * the raw key for sites created by the plugin. Never pass a client-supplied
 * site_install_id: newer plugins send it already hashed, older ones raw.
 *
 * siteHashForAnalytics(raw) = sha256(raw), the unprefixed site_hash property
 * the plugins already send to PostHog.
 */
const crypto = require('crypto');

const INSTALL_ID_PREFIX = 'oppti-install-v1:';

function isUsable(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function installIdFromSiteKey(rawSiteKey) {
  if (!isUsable(rawSiteKey)) return null;
  return crypto.createHash('sha256').update(INSTALL_ID_PREFIX + rawSiteKey).digest('hex');
}

function siteHashForAnalytics(rawSiteKey) {
  if (!isUsable(rawSiteKey)) return null;
  return crypto.createHash('sha256').update(rawSiteKey).digest('hex');
}

module.exports = { INSTALL_ID_PREFIX, installIdFromSiteKey, siteHashForAnalytics };
