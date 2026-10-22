/**
 * Billing currency selection for checkout / plans.
 *
 * Locked rule (PA + Web): use visitor geo country, never locale.
 * USD Price IDs only when country === US. Missing/unknown → GBP.
 */

const USD_PRICE_KEYS = ['starterUsd', 'proUsd', 'agencyUsd', 'creditsUsd'];
const GBP_PRICE_KEYS = ['starter', 'pro', 'agency', 'credits'];

const USD_STATIC_AMOUNTS = {
  starter: 6.99,
  pro: 17.99,
  agency: 67.99,
  credits: 13.99
};

const GBP_STATIC_AMOUNTS = {
  starter: 4.99,
  pro: 12.99,
  agency: null,
  credits: 9.99
};

function normalizeCountryCode(value) {
  if (typeof value !== 'string') return null;
  const code = value.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) return null;
  // Cloudflare unknown / Tor
  if (code === 'XX' || code === 'T1') return null;
  return code;
}

/**
 * Resolve the billing country and where it came from.
 *
 * Checkout requests reach us server-to-server from the customer's WordPress
 * host, so edge geo (CF-IPCountry) describes the *hosting server*, not the
 * admin clicking Upgrade (e.g. a Polish site on a US host geolocated to US).
 * The plugin therefore forwards the WP admin's own country, which wins.
 *
 * Preference order (never Accept-Language / locale headers):
 *  1. Plugin-sent admin country: X-Admin-Country header or body.admin_country
 *  2. Edge geo: CF-IPCountry
 *  3. Other forwarded geo headers (X-Visitor-Country, X-Client-Country, X-Country)
 *  4. Checkout body.country (attribution field)
 * Missing/unknown everywhere -> null (GBP).
 *
 * @returns {{ country: string|null, source: string }}
 */
function resolveBillingCountryWithSource(req = {}) {
  const headers = req.headers || {};
  const body = req.body || {};
  const candidates = [
    ['x-admin-country', headers['x-admin-country']],
    ['body.admin_country', body.admin_country],
    ['cf-ipcountry', headers['cf-ipcountry'] || headers['CF-IPCountry']],
    ['x-visitor-country', headers['x-visitor-country']],
    ['x-client-country', headers['x-client-country']],
    ['x-country', headers['x-country']],
    ['body.country', body.country]
  ];
  for (const [source, value] of candidates) {
    const country = normalizeCountryCode(value);
    if (country) return { country, source };
  }
  return { country: null, source: 'none' };
}

function resolveBillingCountry(req = {}) {
  return resolveBillingCountryWithSource(req).country;
}

function shouldUseUsdPrices(country) {
  return normalizeCountryCode(country) === 'US';
}

function resolveBillingCurrency(country) {
  return shouldUseUsdPrices(country) ? 'usd' : 'gbp';
}

/**
 * Pick the single-grid price IDs for plans/checkout UI.
 * Same plan keys always — USD values only for US, otherwise GBP.
 */
function selectCatalogPriceIds(priceIds = {}, country) {
  const useUsd = shouldUseUsdPrices(country);
  if (useUsd) {
    return {
      starter: priceIds.starterUsd || priceIds.starter || null,
      pro: priceIds.proUsd || priceIds.pro || null,
      agency: priceIds.agencyUsd || priceIds.agency || null,
      credits: priceIds.creditsUsd || priceIds.credits || null
    };
  }
  return {
    starter: priceIds.starter || null,
    pro: priceIds.pro || null,
    agency: priceIds.agency || null,
    credits: priceIds.credits || null
  };
}

function listConfiguredPriceIds(priceIds = {}) {
  return Object.values(priceIds).filter((value) => typeof value === 'string' && value.trim());
}

function findPriceKey(priceIds = {}, priceId) {
  if (!priceId) return null;
  const match = Object.entries(priceIds).find(([, configured]) => configured === priceId);
  return match ? match[0] : null;
}

function isUsdPriceId(priceIds = {}, priceId) {
  const key = findPriceKey(priceIds, priceId);
  return Boolean(key && key.endsWith('Usd'));
}

function canonicalizePlanKey(planKey) {
  if (!planKey) return null;
  return planKey.endsWith('Usd') ? planKey.slice(0, -3) : planKey;
}

/**
 * GBP Price ID for the same plan as a USD Price ID (starterUsd -> starter).
 * Returns null when priceId is not a configured USD price or no GBP twin exists.
 */
function findGbpEquivalentPriceId(priceIds = {}, priceId) {
  const key = findPriceKey(priceIds, priceId);
  if (!key || !USD_PRICE_KEYS.includes(key)) return null;
  const gbpPrice = priceIds[canonicalizePlanKey(key)];
  return typeof gbpPrice === 'string' && gbpPrice.trim() ? gbpPrice : null;
}

function staticAmountForPlan(planId, currency) {
  const table = currency === 'usd' ? USD_STATIC_AMOUNTS : GBP_STATIC_AMOUNTS;
  return table[planId] ?? null;
}

module.exports = {
  USD_PRICE_KEYS,
  GBP_PRICE_KEYS,
  USD_STATIC_AMOUNTS,
  GBP_STATIC_AMOUNTS,
  normalizeCountryCode,
  resolveBillingCountry,
  resolveBillingCountryWithSource,
  shouldUseUsdPrices,
  resolveBillingCurrency,
  selectCatalogPriceIds,
  listConfiguredPriceIds,
  findPriceKey,
  isUsdPriceId,
  canonicalizePlanKey,
  findGbpEquivalentPriceId,
  staticAmountForPlan
};
