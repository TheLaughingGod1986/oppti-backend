/**
 * Static billing plan catalog for plugin checkout UI (no Stripe round-trip).
 * Cached in memory to keep GET /billing/plans and GET /api/billing/plans instant.
 */

const logger = require('../lib/logger');
const DEFAULT_TTL_MS = Number(process.env.BILLING_PLANS_CACHE_TTL_MS || 15 * 60 * 1000);

function buildPlansList(priceIds = {}) {
  return [
    {
      id: 'pro',
      name: 'Pro Plan',
      price: 14.99,
      currency: 'usd',
      interval: 'month',
      quota: 1000,
      sites: 1,
      features: [
        '1,000 AI-generated alt texts per month',
        'WCAG-compliant descriptions',
        'Bulk generate for media library',
        'Priority email support',
        'Use on one WordPress site'
      ],
      priceId: priceIds.pro,
      trialDays: 0,
      scope: 'site'
    },
    {
      id: 'agency',
      name: 'Agency Plan',
      price: 59.99,
      currency: 'usd',
      interval: 'month',
      quota: 10000,
      sites: 'unlimited',
      features: [
        '10,000 AI-generated alt texts per month',
        'WCAG 2.1 AA for all client sites',
        'Bulk generate across multiple sites',
        'Dedicated account manager and priority support',
        'Use on unlimited WordPress sites'
      ],
      priceId: priceIds.agency,
      trialDays: 0,
      scope: 'shared'
    },
    {
      id: 'credits',
      name: 'Credit Pack',
      price: 11.99,
      currency: 'usd',
      interval: 'one-time',
      quota: 100,
      sites: 'any',
      features: [
        '100 credits for alt text generation',
        'Credits never expire',
        'No subscription required',
        'Use on any WordPress site'
      ],
      priceId: priceIds.credits,
      trialDays: 0,
      scope: 'site'
    }
  ];
}

let cache = {
  key: '',
  expiry: 0,
  payload: null
};

/**
 * Returns { success, plans } suitable for JSON responses.
 */
function getBillingPlansJson(priceIds = {}) {
  const key = JSON.stringify({
    pro: priceIds.pro || null,
    agency: priceIds.agency || null,
    credits: priceIds.credits || null
  });
  const now = Date.now();
  if (cache.payload && cache.expiry > now && cache.key === key) {
    logger.debug('[billingPlansCatalog] cache hit');
    return cache.payload;
  }

  const payload = { success: true, plans: buildPlansList(priceIds) };
  cache = { key, expiry: now + DEFAULT_TTL_MS, payload };
  logger.debug('[billingPlansCatalog] cache miss, rebuilt');
  return payload;
}

function invalidateBillingPlansCache() {
  cache = { key: '', expiry: 0, payload: null };
}

module.exports = {
  buildPlansList,
  getBillingPlansJson,
  invalidateBillingPlansCache
};
