/**
 * Site identity in log lines.
 *
 * A site key, a stored site_hash, an install id/hash/uuid and a site
 * fingerprint can all be replayed to resolve a site (auth matches on each of
 * them), so log lines never carry their values. They log only whether one
 * was present and, when a request is at hand, which header or body field
 * carried it.
 */

// Request fields auth accepts as site identity, in the order auth reads them.
const SITE_KEY_HEADERS = [
  'X-Site-Key',
  'X-Site-Hash',
  'X-Trial-Site-Hash',
  'X-Site-Id',
  'X-Install-Hash',
  'X-Install-UUID',
  'X-Site-Fingerprint'
];
const SITE_KEY_BODY_FIELDS = [
  'site_key', 'siteKey', 'site_hash', 'siteHash', 'site_id', 'siteId',
  'installId', 'install_id', 'install_hash', 'installHash', 'install_uuid', 'installUuid',
  'site_install_id', 'site_fingerprint', 'siteFingerprint'
];

function readHeader(req, name) {
  if (!req || typeof req.header !== 'function') return null;
  try {
    return req.header(name) || null;
  } catch (_error) {
    return null;
  }
}

// The header or body field name that carried site identity, or 'none'.
function siteKeySource(req) {
  for (const name of SITE_KEY_HEADERS) {
    if (readHeader(req, name)) return name;
  }
  const body = req && typeof req.body === 'object' && req.body ? req.body : {};
  for (const field of SITE_KEY_BODY_FIELDS) {
    if (body[field]) return `body.${field}`;
  }
  return 'none';
}

// Log fields for a site key or site_hash value: presence only, plus the
// request field that carried it when a request is given.
function siteRefForLog(value, req) {
  const fields = { has_site_key: Boolean(value) };
  if (req && typeof req === 'object') fields.matched_by = siteKeySource(req);
  return fields;
}

// Log fields for an install id / install hash / install uuid value.
function installRefForLog(value) {
  return { has_install_id: Boolean(value) };
}

// Log fields for a site fingerprint value.
function fingerprintRefForLog(value) {
  return { has_site_fingerprint: Boolean(value) };
}

module.exports = {
  SITE_KEY_HEADERS,
  SITE_KEY_BODY_FIELDS,
  siteKeySource,
  siteRefForLog,
  installRefForLog,
  fingerprintRefForLog
};
