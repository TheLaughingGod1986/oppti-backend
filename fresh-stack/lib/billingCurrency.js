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
 * Resolve visitor country from request geo signals only (not Accept-Language / locale).
 * Preference order:
 *  1. Cloudflare CF-IPCountry
 *  2. Plugin-forwarded admin/visitor country headers
 *  3. Checkout body.country (plugin geo from admin IP) — never locale
 */
function resolveBillingCountry(req = {}) {
  const headers = req.headers || {};
  const headerCountry = normalizeCountryCode(
    headers['cf-ipcountry']
    || headers['CF-IPCountry']
    || headers['x-visitor-country']
    || headers['x-client-country']
    || headers['x-admin-country']
    || headers['x-country']
  );
  if (headerCountry) return headerCountry;

  const body = req.body || {};
  return normalizeCountryCode(body.country);
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
  shouldUseUsdPrices,
  resolveBillingCurrency,
  selectCatalogPriceIds,
  listConfiguredPriceIds,
  findPriceKey,
  isUsdPriceId,
  canonicalizePlanKey,
  staticAmountForPlan
};
