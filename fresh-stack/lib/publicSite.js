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

// Raw site key fields: removed for every caller.
const RAW_SITE_KEY_FIELDS = new Set(['site_hash', 'siteHash', 'site_key', 'siteKey', 'trial_site_hash']);

// accountCredential: the caller signed in with a password, JWT or the
// account's own licence key. Those callers keep the rest of the row (Alt
// Text's has_active_license() needs the site object); only the raw site key
// goes. A site-key-only caller also loses the licence key, install uuid and
// fingerprint.
function publicSite(site, { accountCredential = false } = {}) {
  if (!site || typeof site !== 'object' || Array.isArray(site)) return site ?? null;
  const rawKey = typeof site.site_hash === 'string' && site.site_hash ? site.site_hash : null;
  const out = {};
  for (const [key, value] of Object.entries(site)) {
    if (RAW_SITE_KEY_FIELDS.has(key)) continue;
    // The same raw key under another column (wp_install_uuid often equals
    // it, and auth accepts it as X-Install-UUID) goes too.
    if (rawKey && value === rawKey) continue;
    if (!accountCredential && isSecretField(key)) continue;
    out[key] = value;
  }
  const installId = installIdFromSiteKey(site.site_hash || site.siteHash || null);
  if (installId) out.site_install_id = installId;
  return out;
}

function publicSites(sites, options) {
  return Array.isArray(sites) ? sites.map((site) => publicSite(site, options)) : sites;
}

function isAccountCredential(req) {
  return ['jwt', 'license'].includes(req?.authMethod) || Boolean(req?.header?.('X-License-Key'));
}

module.exports = { publicSite, publicSites, isSecretField, isAccountCredential, RAW_SITE_KEY_FIELDS };
