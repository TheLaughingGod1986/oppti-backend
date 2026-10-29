// Site rows in HTTP responses. sites.site_hash holds the raw site key (it
// replays as X-Site-Key), and rows can carry the licence key, install uuid
// and fingerprint. A response gets the row id and the hashed install id
// (sha256("oppti-install-v1:" + key), the plugin formula) instead.
const { installIdFromSiteKey } = require('./installId');

const LICENCE_KEY_PATTERN = /licen[cs]e[\W_]*key/i;
const SECRET_SITE_FIELDS = new Set([
  'site_hash', 'siteHash', 'site_key', 'siteKey', 'wp_install_uuid', 'install_uuid', 'installUuid',
  'install_id', 'installId', 'site_fingerprint', 'siteFingerprint', 'fingerprint', 'trial_site_hash'
]);

function isSecretField(key) {
  return SECRET_SITE_FIELDS.has(key) || LICENCE_KEY_PATTERN.test(key);
}

function publicSite(site) {
  if (!site || typeof site !== 'object' || Array.isArray(site)) return site ?? null;
  const out = {};
  for (const [key, value] of Object.entries(site)) {
    if (!isSecretField(key)) out[key] = value;
  }
  const installId = installIdFromSiteKey(site.site_hash || site.siteHash || null);
  if (installId) out.site_install_id = installId;
  return out;
}

function publicSites(sites) {
  return Array.isArray(sites) ? sites.map(publicSite) : sites;
}

module.exports = { publicSite, publicSites, isSecretField };
