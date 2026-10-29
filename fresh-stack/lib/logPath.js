// Path value for log lines. Request paths can carry an email address or a
// licence key (for example /billing/<email>/<key>), so only a path that cannot
// hold either is logged as-is. Everything else becomes 'other'. The query
// string and fragment are never logged.

// Fixed public routes that are safe to name even though they sit under /billing.
const FIXED_PUBLIC_PATHS = new Set([
  '/billing/plans',
  '/api/billing/plans',
  '/billing/health',
  '/api/billing/health'
]);
// Any path under these may carry an email, key or token.
const SENSITIVE_PREFIX = /^\/(api\/)?(billing|licen[cs]es?|auth)(\/|$)/;
const MAX_LOGGED_PATH = 200;

// A segment that could be a key, token or id: 12+ characters of letters,
// digits, '-' or '_' containing both a letter and a digit (UUID licence keys,
// QA-FAKE-LICENSE-KEY-0001 style keys, JWT-ish tokens). Plain words such as
// trial-batch-plan stay readable.
function looksLikeKey(segment) {
  return segment.length >= 12
    && /^[A-Za-z0-9_.-]+$/.test(segment)
    && /[0-9]/.test(segment)
    && /[A-Za-z]/.test(segment);
}

function safeLogPath(raw) {
  if (typeof raw !== 'string' || !raw) return 'other';
  const path = raw.split(/[?#]/)[0];
  if (!path || path.length > MAX_LOGGED_PATH) return 'other';
  // '@' is an email; any percent-encoding (%40 and friends) is not worth decoding.
  if (/[@%]/.test(path)) return 'other';
  const normalized = path.toLowerCase().replace(/\/+$/, '') || '/';
  if (FIXED_PUBLIC_PATHS.has(normalized)) return normalized;
  if (SENSITIVE_PREFIX.test(normalized)) return 'other';
  if (path.split('/').some(looksLikeKey)) return 'other';
  return path.replace(/(.)\/+$/, '$1');
}

// Raw site key values a request can carry (headers and body). auth accepts
// each of them as site identity.
function rawSiteKeysFromRequest(req) {
  const body = req?.body || {};
  const header = (name) => (typeof req?.header === 'function' ? req.header(name) : null);
  return [
    header('X-Site-Key'), header('X-Site-Hash'), header('X-Site-Id'), header('X-Site-ID'), header('X-Trial-Site-Hash'),
    header('X-Install-Hash'), header('X-Install-UUID'), header('X-Site-Fingerprint'),
    body.site_key, body.siteKey, body.site_hash, body.siteHash, body.site_id, body.siteId,
    body.installId, body.install_id
  ].filter(Boolean);
}

module.exports = { safeLogPath, looksLikeKey, FIXED_PUBLIC_PATHS, rawSiteKeysFromRequest };
