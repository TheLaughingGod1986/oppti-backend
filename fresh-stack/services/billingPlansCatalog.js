/**
 * Static billing plan catalog for plugin checkout UI (no Stripe round-trip).
 * Cached in memory to keep GET /billing/plans and GET /api/billing/plans instant.
 */

const logger = require('../lib/logger');
const DEFAULT_TTL_MS = Number(process.env.BILLING_PLANS_CACHE_TTL_MS || 15 * 60 * 1000);

function buildPlansList(priceIds = {}) {
  return [
    {
      id: 'starter',
      name: 'Starter',
      badge: 'Best for small sites',
      price: 4.99,
      currency: 'gbp',
      interval: 'month',
      quota: 100,
      sites: 1,
      description: 'Get 100 monthly images for smaller WordPress sites.',
      features: [
        '100 monthly images',
        'Great for small business websites',
        'Cancel anytime'
      ],
      cta: 'Upgrade to Starter',
      priceId: priceIds.starter,
      trialDays: 0,
      scope: 'site'
    },
    {
      id: 'pro',
      name: 'Growth',
      badge: 'Best value',
      price: 12.99,
      currency: 'gbp',
      interval: 'month',
      quota: 1000,
      sites: 1,
      description: 'Get 1,000 monthly images, bulk processing, and Autopilot.',
      features: [
        '1,000 monthly images',
        'Bulk processing',
        'Autopilot for new uploads',
        'Cancel anytime'
      ],
      cta: 'Upgrade to Growth',
      priceId: priceIds.pro,
      trialDays: 0,
      scope: 'site'
    },
    {
      id: 'credits',
      name: 'Buy 100 extra credits',
      badge: 'Alternative',
      price: 9.99,
      currency: 'gbp',
      interval: 'one-time',
      quota: 100,
      sites: 'any',
      description: 'Need a quick top-up without a subscription?',
      features: [
        '100 extra credits',
        'No subscription required'
      ],
      cta: 'Buy more credits',
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
    starter: priceIds.starter || null,
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
