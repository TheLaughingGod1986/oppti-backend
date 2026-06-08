const UNLIMITED_PLAN_TYPES = new Set(['unlimited']);
const PAID_PLAN_TYPES = new Set(['pro', 'growth', 'agency', 'enterprise']);
const PAID_MINIMUM_MONTHLY_CREDITS = 1000;

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

function normalizePlanForAllowance(plan, tokenLimit, unlimited) {
  const normalized = String(plan || 'free').trim().toLowerCase() || 'free';
  if (normalized === 'growth') {
    return tokenLimit !== null && tokenLimit < PAID_MINIMUM_MONTHLY_CREDITS ? 'free' : 'pro';
  }

  if (
    !unlimited
    && PAID_PLAN_TYPES.has(normalized)
    && tokenLimit !== null
    && tokenLimit < PAID_MINIMUM_MONTHLY_CREDITS
  ) {
    return 'free';
  }

  return normalized;
}

function buildEntitlementState(status = {}, {
  isLoggedIn = null,
  isTrial = null
} = {}) {
  const rawPlan = status.plan || status.plan_type || 'free';
  const rawLimit = firstDefined(status.token_limit, status.total_limit, status.credits_total);
  const parsedLimit = rawLimit === undefined ? null : Number(rawLimit);
  const unlimited = status.is_unlimited === true
    || (Number.isFinite(parsedLimit) && parsedLimit < 0)
    || UNLIMITED_PLAN_TYPES.has(String(rawPlan).toLowerCase());
  const tokenLimit = unlimited ? null : toNonNegativeNumber(rawLimit, null);
  const plan = normalizePlanForAllowance(rawPlan, tokenLimit, unlimited);
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
  const dailyGenerationLimit = unlimited
    ? null
    : toNonNegativeNumber(status.daily_generation_limit, null);
  const dailyGenerationsUsed = dailyGenerationLimit === null
    ? null
    : toNonNegativeNumber(status.daily_generations_used, 0);
  const dailyGenerationsRemaining = dailyGenerationLimit === null
    ? null
    : toNonNegativeNumber(
      status.daily_generations_remaining,
      Math.max(dailyGenerationLimit - dailyGenerationsUsed, 0)
    );
  const loggedIn = typeof isLoggedIn === 'boolean'
    ? isLoggedIn
    : status.auth_state !== 'guest_trial' && plan !== 'trial';
  const trial = typeof isTrial === 'boolean'
    ? isTrial
    : status.auth_state === 'guest_trial' || plan === 'trial';
  const monthlyBlocked = !unlimited && tokensRemaining <= 0;
  const dailyBlocked = !unlimited
    && dailyGenerationLimit !== null
    && dailyGenerationsRemaining <= 0;
  const canGenerate = unlimited || (!monthlyBlocked && !dailyBlocked);
  const quotaState = status.quota_state
    || (monthlyBlocked ? 'exhausted' : (dailyBlocked ? 'daily_exhausted' : (status.is_near_limit ? 'near_limit' : 'active')));
  const upgradeRequired = typeof status.upgrade_required === 'boolean'
    ? status.upgrade_required
    : (!canGenerate && loggedIn && plan === 'free');

  return {
    plan,
    plan_type: plan,
    token_limit: tokenLimit,
    tokens_used_this_month: tokensUsedThisMonth,
    total_tokens_used: totalTokensUsed,
    tokens_remaining: tokensRemaining,
    daily_generation_limit: dailyGenerationLimit,
    daily_generations_used: dailyGenerationsUsed,
    daily_generations_remaining: dailyGenerationsRemaining,
    daily_reset_date: status.daily_reset_date || null,
    can_generate: canGenerate,
    can_autopilot: loggedIn && !trial && plan !== 'free' && canGenerate,
    is_logged_in: loggedIn,
    is_trial: trial,
    is_unlimited: unlimited,
    reset_date: status.reset_date || status.resetDate || null,
    last_generation_at: status.last_generation_at || null,
    upgrade_required: upgradeRequired,
    quota_state: quotaState,
    message: !canGenerate
      ? (trial ? 'Free trial exhausted.' : (monthlyBlocked ? 'Monthly credits exhausted.' : 'Daily generation allowance exhausted.'))
      : null
  };
}

module.exports = {
  buildEntitlementState,
  normalizePlanForAllowance,
  PAID_MINIMUM_MONTHLY_CREDITS
};
