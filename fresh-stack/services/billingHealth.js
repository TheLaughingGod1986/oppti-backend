/**
 * Billing health check — a fast "can checkout work right now?" probe for
 * support/diagnostics. Read-only and side-effect free; never throws.
 *
 * Returns booleans only (no secrets), so it can be served unauthenticated like
 * /billing/plans:
 *   { stripe, starter, pro, entitlements, timestamp }
 */

const { getBillingPlansJsonLive } = require('./billingPlansCatalog');

/**
 * @param {object}   opts
 * @param {object}   opts.priceIds  { starter, pro, agency, credits }
 * @param {function} opts.getStripe Returns a Stripe client (or null).
 * @param {object}   opts.supabase  Supabase client (or null).
 */
async function buildBillingHealth({ priceIds = {}, getStripe, supabase } = {}) {
  const result = {
    stripe: false,
    starter: false,
    pro: false,
    entitlements: false,
    timestamp: new Date().toISOString()
  };

  // Stripe + plan availability — reuse the live catalog, which already marks a
  // plan unavailable when its Stripe price can't be retrieved or is archived.
  const stripe = typeof getStripe === 'function' ? getStripe() : null;
  try {
    const payload = await getBillingPlansJsonLive(priceIds, getStripe);
    const plans = Array.isArray(payload?.plans) ? payload.plans : [];
    const planOk = (id) => {
      const plan = plans.find((p) => p.id === id);
      return Boolean(plan && plan.available !== false && plan.priceId);
    };
    // A plan is only "healthy" if Stripe is reachable AND its price resolved —
    // without a Stripe client the catalog falls back to its static list, which
    // can't be trusted as verification.
    result.starter = Boolean(stripe) && planOk('starter');
    result.pro = Boolean(stripe) && planOk('pro');
    // "stripe" is healthy when a client is configured and at least one paid
    // plan's price resolved from Stripe.
    result.stripe = Boolean(stripe) && (result.starter || result.pro);
  } catch (_err) {
    // leave the stripe/plan flags false
  }

  // Entitlements — the price->plan mapping is configured AND the entitlement
  // store (Supabase `plans` table) is reachable with the expected plan rows.
  const mappingConfigured = Boolean(priceIds.pro) && Boolean(priceIds.starter);
  if (mappingConfigured && supabase) {
    try {
      const { data, error } = await supabase
        .from('plans')
        .select('id')
        .in('id', ['starter', 'pro']);
      const ids = Array.isArray(data) ? data.map((row) => row && row.id) : [];
      result.entitlements = !error && ids.includes('starter') && ids.includes('pro');
    } catch (_err) {
      result.entitlements = false;
    }
  }

  return result;
}

module.exports = { buildBillingHealth };
