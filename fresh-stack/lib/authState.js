// usage_logs.auth_state values: 'guest_trial' (no account), 'authenticated_free',
// 'authenticated_paid', 'authenticated_unknown' (legacy backfill only).
const AUTH_STATE_FREE = 'authenticated_free';
const AUTH_STATE_PAID = 'authenticated_paid';
const UNPAID_PLANS = new Set(['', 'free', 'trial', 'credits']);

/** Label a signed-in generation from the licence's own plan. */
function authStateForPlan(plan) {
  const normalized = String(plan || '').trim().toLowerCase();
  return UNPAID_PLANS.has(normalized) ? AUTH_STATE_FREE : AUTH_STATE_PAID;
}

module.exports = { AUTH_STATE_FREE, AUTH_STATE_PAID, authStateForPlan };
