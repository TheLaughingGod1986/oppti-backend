/**
 * Host allowlists for URLs the backend hands to third parties.
 *
 * - Stripe successUrl / cancelUrl / returnUrl (checkout + portal): a caller URL
 *   is allowed when its host is one of the account's registered site hosts (or
 *   a subdomain of one), or oppti.dev. www.<host> and <host> are the same host.
 *   Only http and https. Week one is log-only: BILLING_REDIRECT_ALLOWLIST_ENFORCE
 *   (default off) switches unlisted URLs to an oppti.dev fallback page.
 * - Loops websiteUrl: kept only when its host matches a registered site host.
 *
 * Logs carry the host only, never the full URL, its query, or any email.
 */
const { normalizeDomain, normalizeHost } = require('../lib/siteIdentity');

const OPPTI_HOST = 'oppti.dev';
const OPPTI_ORIGIN = 'https://oppti.dev';

// Pages that exist on oppti.dev (checked 22 Oct 2026: /billing/success 200
// "Confirming payment", /billing/cancel 200 "Checkout Canceled", /account 307
// to /login?redirect=/account; /billing itself is a 404).
const BILLING_FALLBACK_URLS = Object.freeze({
  success: `${OPPTI_ORIGIN}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
  cancel: `${OPPTI_ORIGIN}/billing/cancel`,
  portalReturn: `${OPPTI_ORIGIN}/account`
});

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on', 'enforce']);
const SITE_HOST_COLUMNS = 'id, site_url, canonical_domain, normalized_site_url';
const MAX_LOGGED_HOST_LENGTH = 253;

function isFlagOn(value) {
  return TRUE_VALUES.has(String(value ?? '').trim().toLowerCase());
}

function isBillingRedirectEnforced(env = process.env) {
  return isFlagOn(env.BILLING_REDIRECT_ALLOWLIST_ENFORCE);
}

function hostFromSiteValue(value) {
  if (!value || typeof value !== 'string') return null;
  return normalizeDomain(value) || null;
}

function hostsFromSite(site) {
  if (!site || typeof site !== 'object') return [];
  return [site.site_url, site.canonical_domain, site.normalized_site_url]
    .map(hostFromSiteValue)
    .filter(Boolean);
}

function uniqueHosts(hosts) {
  return [...new Set((hosts || []).map((host) => normalizeHost(host)).filter(Boolean))];
}

function collectSiteHosts(sites) {
  return uniqueHosts((sites || []).flatMap(hostsFromSite));
}

function hostMatches(host, registeredHost) {
  if (!host || !registeredHost) return false;
  if (host === registeredHost) return true;
  // Subdomains only of a real registrable-looking host, never of "com" etc.
  return registeredHost.includes('.') && host.endsWith(`.${registeredHost}`);
}

/**
 * Parse a caller-supplied URL. Returns { host, reason } where reason is null
 * for a parseable http(s) URL without embedded credentials.
 */
function parseRedirectUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) {
    return { host: null, reason: 'invalid_url' };
  }
  let parsed;
  try {
    parsed = new URL(rawUrl.trim());
  } catch (_error) {
    return { host: null, reason: 'invalid_url' };
  }
  const host = normalizeHost(parsed.hostname);
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { host, reason: 'scheme_not_allowed' };
  }
  if (parsed.username || parsed.password) {
    return { host, reason: 'credentials_in_url' };
  }
  if (!host) {
    return { host: null, reason: 'invalid_url' };
  }
  return { host, reason: null };
}

/**
 * Decide whether a URL may be used as a Stripe redirect.
 * @returns {{ allowed: boolean, host: string|null, reason: string|null }}
 */
function evaluateBillingRedirect(rawUrl, registeredHosts = []) {
  const { host, reason } = parseRedirectUrl(rawUrl);
  if (reason) return { allowed: false, host, reason };
  if (hostMatches(host, OPPTI_HOST)) return { allowed: true, host, reason: null };
  const hosts = uniqueHosts(registeredHosts);
  if (hosts.length === 0) return { allowed: false, host, reason: 'no_registered_site' };
  if (hosts.some((registered) => hostMatches(host, registered))) {
    return { allowed: true, host, reason: null };
  }
  return { allowed: false, host, reason: 'host_not_registered' };
}

/**
 * Loops websiteUrl rule: only a registered site host (or a subdomain of one).
 * No oppti.dev exception, no flag.
 */
function isWebsiteUrlForRegisteredSite(rawUrl, registeredHosts = []) {
  const { host, reason } = parseRedirectUrl(rawUrl);
  if (reason || !host) return false;
  return uniqueHosts(registeredHosts).some((registered) => hostMatches(host, registered));
}

function truncateHost(host) {
  if (!host) return null;
  return String(host).slice(0, MAX_LOGGED_HOST_LENGTH);
}

async function selectSites(query) {
  try {
    const result = await query;
    return Array.isArray(result?.data) ? result.data : [];
  } catch (_error) {
    return [];
  }
}

/**
 * Every site host registered to an account: sites on its license key, sites it
 * owns, and sites it is a member of. Never throws; a failed lookup contributes
 * nothing (so in enforce mode it falls back to oppti.dev, never an error).
 */
async function loadAccountSiteHosts(supabase, account, { extraSites = [] } = {}) {
  const sites = [...(extraSites || []).filter(Boolean)];
  if (supabase && typeof supabase.from === 'function' && account) {
    if (account.license_key) {
      sites.push(...await selectSites(
        Promise.resolve().then(() => supabase.from('sites').select(SITE_HOST_COLUMNS).eq('license_key', account.license_key))
      ));
    }
    if (account.id) {
      sites.push(...await selectSites(
        Promise.resolve().then(() => supabase.from('sites').select(SITE_HOST_COLUMNS).eq('owner_user_id', account.id))
      ));
      const memberships = await selectSites(
        Promise.resolve().then(() => supabase.from('site_memberships').select('site_id').eq('user_id', account.id))
      );
      const siteIds = memberships.map((row) => row?.site_id).filter(Boolean);
      if (siteIds.length > 0) {
        sites.push(...await selectSites(
          Promise.resolve().then(() => supabase.from('sites').select(SITE_HOST_COLUMNS).in('id', siteIds))
        ));
      }
    }
  }
  return collectSiteHosts(sites);
}

/**
 * Site hosts registered to the account that owns this email (Loops contacts).
 * No account, or any lookup error, means no hosts.
 */
async function loadSiteHostsForEmail(supabase, email) {
  if (!supabase || typeof supabase.from !== 'function' || typeof email !== 'string' || !email.trim()) {
    return [];
  }
  let account = null;
  try {
    const { data } = await supabase
      .from('licenses')
      .select('id, license_key')
      .eq('email', email.trim().toLowerCase())
      .maybeSingle();
    account = data || null;
  } catch (_error) {
    account = null;
  }
  if (!account) return [];
  return loadAccountSiteHosts(supabase, account);
}

/**
 * Apply the Stripe redirect allowlist to one caller URL.
 * - No caller URL: returns null so the route keeps its existing default.
 * - Allowed: the caller URL unchanged.
 * - Not allowed, flag off: the caller URL unchanged plus one structured warning.
 * - Not allowed, flag on: the oppti.dev fallback plus one structured warning.
 */
function resolveBillingRedirect({
  url,
  field,
  fallbackUrl,
  registeredHosts,
  logger,
  context = {},
  env = process.env
}) {
  if (url === undefined || url === null || url === '') return null;
  const decision = evaluateBillingRedirect(url, registeredHosts);
  if (decision.allowed) return url;
  const enforced = isBillingRedirectEnforced(env);
  if (logger && typeof logger.warn === 'function') {
    logger.warn('[billing] redirect_url_not_allowlisted', {
      field,
      host: truncateHost(decision.host),
      reason: decision.reason,
      enforced,
      action: enforced ? 'fallback' : 'used_as_sent',
      fallback: enforced ? fallbackUrl.split('?')[0] : null,
      registered_host_count: uniqueHosts(registeredHosts).length,
      ...context
    });
  }
  return enforced ? fallbackUrl : url;
}

module.exports = {
  BILLING_FALLBACK_URLS,
  OPPTI_HOST,
  collectSiteHosts,
  evaluateBillingRedirect,
  hostMatches,
  hostsFromSite,
  isBillingRedirectEnforced,
  isFlagOn,
  isWebsiteUrlForRegisteredSite,
  loadAccountSiteHosts,
  loadSiteHostsForEmail,
  parseRedirectUrl,
  resolveBillingRedirect
};
