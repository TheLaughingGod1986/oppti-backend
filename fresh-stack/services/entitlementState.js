const UNLIMITED_PLAN_TYPES = new Set(['unlimited']);

function toNonNegativeNumber(value, fallback = null) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(parsed, 0);
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null);
}

function buildEntitlementState(status = {}, {
  isLoggedIn = null,
  isTrial = null
} = {}) {
  const plan = status.plan || status.plan_type || 'free';
  const rawLimit = firstDefined(status.token_limit, status.total_limit, status.credits_total);
  const parsedLimit = rawLimit === undefined ? null : Number(rawLimit);
  const unlimited = status.is_unlimited === true
    || (Number.isFinite(parsedLimit) && parsedLimit < 0)
    || UNLIMITED_PLAN_TYPES.has(String(plan).toLowerCase());
  const tokenLimit = unlimited ? null : toNonNegativeNumber(rawLimit, null);
  const tokensUsedThisMonth = toNonNegativeNumber(
    firstDefined(status.tokens_used_this_month, status.credits_used),
    0
  );
  const totalTokensUsed = toNonNegativeNumber(
    firstDefined(status.total_tokens_used, tokensUsedThisMonth),
    tokensUsedThisMonth
  );
  const reportedRemaining = firstDefined(status.tokens_remaining, status.credits_remaining, status.remaining);
  const tokensRemaining = unlimited
    ? null
    : toNonNegativeNumber(
      reportedRemaining,
      tokenLimit === null ? 0 : Math.max(tokenLimit - tokensUsedThisMonth, 0)
    );
  const loggedIn = typeof isLoggedIn === 'boolean'
    ? isLoggedIn
    : status.auth_state !== 'guest_trial' && plan !== 'trial';
  const trial = typeof isTrial === 'boolean'
    ? isTrial
    : status.auth_state === 'guest_trial' || plan === 'trial';
  const canGenerate = unlimited || tokensRemaining > 0;
  const quotaState = status.quota_state
    || (canGenerate ? (status.is_near_limit ? 'near_limit' : 'active') : 'exhausted');
  const upgradeRequired = typeof status.upgrade_required === 'boolean'
    ? status.upgrade_required
    : (!canGenerate && loggedIn && plan === 'free');

  return {
    plan,
    plan_type: status.plan_type || plan,
    token_limit: tokenLimit,
    tokens_used_this_month: tokensUsedThisMonth,
    total_tokens_used: totalTokensUsed,
    tokens_remaining: tokensRemaining,
    can_generate: canGenerate,
    can_autopilot: loggedIn && canGenerate,
    is_logged_in: loggedIn,
    is_trial: trial,
    is_unlimited: unlimited,
    reset_date: status.reset_date || status.resetDate || null,
    last_generation_at: status.last_generation_at || null,
    upgrade_required: upgradeRequired,
    quota_state: quotaState,
    message: !canGenerate
      ? (trial ? 'Free trial exhausted.' : 'Monthly credits exhausted.')
      : null
  };
}

module.exports = {
  buildEntitlementState
};
