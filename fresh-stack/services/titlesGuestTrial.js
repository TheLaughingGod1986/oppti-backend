/**
 * Titles guest first result: a signed-out WordPress site gets a small number
 * of real title + meta generations before it has an account.
 *
 * Mirrors the Alt Text guest trial:
 *  - same auth gate (middleware/auth.js: X-Trial-Mode / X-Trial-Site-Hash,
 *    no licence, API key or bearer token);
 *  - same per-site bucket (site_trials via bbai_reserve_site_generation in
 *    'trial' mode), so the cap is the shared ANONYMOUS_TRIAL_CREDITS value
 *    (10 per site today) and one Titles guest try uses one trial credit;
 *  - same 402 TRIAL_EXHAUSTED body (services/anonymousTrial.js fields).
 *
 * Differences from Alt Text, on purpose:
 *  - The cap is keyed on a value derived on the server from the normalised
 *    site URL, not on the plugin's site id. The plugin's id is random per
 *    install and lives in a WordPress option, so deleting and reinstalling
 *    the plugin (or resetting its options) would otherwise hand out a fresh
 *    allowance. A reinstall cannot change the site URL.
 *  - The per-site try is reserved before anything else can answer the
 *    request, and every guest request gets its own idempotency key and
 *    fingerprint, so the reservation RPC's replay paths (same idempotency
 *    key, or same fingerprint within two minutes) can never return a result
 *    without counting a try. Titles has no result cache today; this keeps it
 *    that way for guests if one is added.
 */

const crypto = require('crypto');
const { buildSiteIdentity, normalizeSiteUrl } = require('../lib/siteIdentity');

// One guest try = one trial credit from the site's trial bucket.
const TITLES_GUEST_CREDITS_PER_TRY = 1;

// Namespace for the derived key. Not a secret: it only has to be stable, so
// it must never depend on an environment value that could be rotated.
const GUEST_SITE_KEY_NAMESPACE = 'oppti-titles-guest-site:v1';
const GUEST_SITE_KEY_PREFIX = 'tg_';

/**
 * Stable per-site key for the guest allowance, derived from the normalised
 * site URL (host without www., port, path; no scheme, query or trailing
 * slash). Returns null when the URL can't be parsed.
 */
function deriveGuestSiteKey(siteUrl) {
  const normalized = normalizeSiteUrl(siteUrl);
  if (!normalized.isValid || !normalized.normalizedSiteUrl) return null;
  const digest = crypto
    .createHash('sha256')
    .update(`${GUEST_SITE_KEY_NAMESPACE}:${normalized.normalizedSiteUrl.toLowerCase()}`)
    .digest('hex');
  return `${GUEST_SITE_KEY_PREFIX}${digest.slice(0, 40)}`;
}

function guestSiteUrlFromRequest(req) {
  return req.header('X-Site-URL')
    || req.body?.trial_site_url
    || req.body?.site_url
    || null;
}

/**
 * Site identity for a guest Titles request. The plugin's own site id and
 * install hash are deliberately not used for the cap.
 * Development hosts are allowed, as on the Alt Text guest path.
 */
function buildGuestSiteIdentity(req) {
  const siteUrl = guestSiteUrlFromRequest(req);
  const guestSiteKey = deriveGuestSiteKey(siteUrl);
  if (!guestSiteKey) {
    return { error: 'GUEST_SITE_URL_REQUIRED', guestSiteKey: null, siteIdentity: null };
  }
  const siteIdentity = buildSiteIdentity({
    siteUrl,
    siteHash: guestSiteKey,
    installUuid: guestSiteKey,
    siteFingerprint: null,
    allowDevelopment: true
  });
  return {
    error: siteIdentity.error || null,
    guestSiteKey,
    siteIdentity
  };
}

/**
 * Unique per request so the reservation RPC never treats a guest request as
 * a replay of an earlier one. Client-sent idempotency keys are ignored for
 * guests for the same reason.
 */
function buildGuestReservationKeys(baseFingerprint) {
  const nonce = crypto.randomUUID();
  return {
    idempotencyKey: `titles-guest:${nonce}`,
    requestFingerprint: crypto
      .createHash('sha256')
      .update(`${baseFingerprint || ''}:${nonce}`)
      .digest('hex')
  };
}

module.exports = {
  GUEST_SITE_KEY_PREFIX,
  TITLES_GUEST_CREDITS_PER_TRY,
  buildGuestReservationKeys,
  buildGuestSiteIdentity,
  deriveGuestSiteKey,
  guestSiteUrlFromRequest
};
