const logger = require('../lib/logger');
const { isMissingSchemaError } = require('../lib/supabaseErrors');
const { getLimits } = require('./planLimits');

const ANONYMOUS_NEAR_LIMIT_THRESHOLD = 0.8;
const FREE_PLAN_OFFER = getLimits('free').credits;

function getAnonymousTrialLimit() {
  const configured = Number(
    process.env.ANONYMOUS_TRIAL_CREDITS
    || process.env.SITE_TRIAL_CREDITS
    || process.env.TRIAL_LIMIT
    || 5
  );

  if (!Number.isFinite(configured) || configured < 1) {
    return 5;
  }

  return Math.max(1, Math.floor(configured));
}

function getAnonymousQuotaState({ used = 0, limit = getAnonymousTrialLimit() } = {}) {
  const normalizedLimit = Math.max(1, Number(limit) || getAnonymousTrialLimit());
  const normalizedUsed = Math.max(Number(used) || 0, 0);
  const remaining = Math.max(normalizedLimit - normalizedUsed, 0);

  if (remaining <= 0) {
    return 'exhausted';
  }

  if (normalizedUsed / normalizedLimit >= ANONYMOUS_NEAR_LIMIT_THRESHOLD || remaining <= 1) {
    return 'near_limit';
  }

  return 'active';
}

async function countLegacyAnonymousUsage(supabase, { siteHash }) {
  if (!supabase || !siteHash) return null;

  const { count, error } = await supabase
    .from('trial_usage')
    .select('id', { count: 'exact', head: true })
    .eq('site_hash', siteHash);

  if (error) {
    if (!isMissingSchemaError(error)) {
      logger.warn('[anonymousTrial] legacy usage count failed', {
        site_hash: siteHash,
        error: error.message
      });
    }
    return null;
  }

  return Number(count || 0);
}

function buildAnonymousTrialStatus({ used, limit = getAnonymousTrialLimit(), anonId = null }) {
  const normalizedLimit = Math.max(1, Number(limit) || getAnonymousTrialLimit());
  const normalizedUsed = Math.max(Number(used) || 0, 0);
  const remaining = Math.max(normalizedLimit - normalizedUsed, 0);
  const exhausted = normalizedUsed >= normalizedLimit;
  const quotaState = getAnonymousQuotaState({
    used: normalizedUsed,
    limit: normalizedLimit
  });

  return {
    auth_state: 'anonymous',
    quota_type: 'trial',
    quota_state: quotaState,
    credits_total: normalizedLimit,
    credits_used: normalizedUsed,
    credits_remaining: remaining,
    total_limit: normalizedLimit,
    limit: normalizedLimit,
    trial_used: normalizedUsed,
    trial_remaining: remaining,
    trial_exhausted: exhausted,
    trial_limit: normalizedLimit,
    signup_required: exhausted,
    upgrade_required: false,
    free_plan_offer: FREE_PLAN_OFFER,
    warning_threshold: ANONYMOUS_NEAR_LIMIT_THRESHOLD,
    is_near_limit: quotaState === 'near_limit',
    plan_type: 'trial',
    billing_cycle: 'trial',
    anon_id: anonId || null,
    anonymous: {
      auth_state: 'anonymous',
      anon_id: anonId || null,
      used: normalizedUsed,
      remaining,
      total: normalizedLimit,
      quota_type: 'trial',
      quota_state: quotaState,
      signup_required: exhausted,
      upgrade_required: false,
      free_plan_offer: FREE_PLAN_OFFER
    }
  };
}

async function getAnonymousTrialStatus(supabase, {
  quotaStatus = {},
  siteHash = null,
  anonId = null
} = {}) {
  const trial = quotaStatus?.trial || null;
  const usedFromV2 = Number(trial?.used_trial_credits);
  const limitFromV2 = Number(trial?.total_trial_credits);

  if (Number.isFinite(usedFromV2)) {
    const status = buildAnonymousTrialStatus({
      used: usedFromV2,
      limit: Number.isFinite(limitFromV2) && limitFromV2 > 0 ? limitFromV2 : getAnonymousTrialLimit(),
      anonId
    });
    logger.info('[anonymousTrial] quota resolved', {
      source: 'site_trials',
      site_hash: siteHash,
      anon_id: anonId || null,
      credits_used: status.credits_used,
      credits_total: status.credits_total,
      credits_remaining: status.credits_remaining,
      quota_state: status.quota_state,
      signup_required: status.signup_required
    });
    return status;
  }

  const used = await countLegacyAnonymousUsage(supabase, { siteHash });
  if (used === null || used === undefined) {
    return null;
  }

  const normalizedUsed = Number(used);
  if (!Number.isFinite(normalizedUsed)) {
    return null;
  }

  const status = buildAnonymousTrialStatus({
    used: normalizedUsed,
    limit: getAnonymousTrialLimit(),
    anonId
  });
  logger.info('[anonymousTrial] quota resolved', {
    source: 'trial_usage',
    site_hash: siteHash,
    anon_id: anonId || null,
    credits_used: status.credits_used,
    credits_total: status.credits_total,
    credits_remaining: status.credits_remaining,
    quota_state: status.quota_state,
    signup_required: status.signup_required
  });
  return status;
}

async function getAnonymousTrialContinuity(supabase, {
  siteId = null,
  siteHash = null
} = {}) {
  if (supabase && siteId) {
    const { data, error } = await supabase
      .from('site_trials')
      .select('total_trial_credits, used_trial_credits, status')
      .eq('site_id', siteId)
      .order('created_at', { ascending: false })
      .limit(1);

    if (!error && Array.isArray(data) && data.length > 0) {
      const trial = data[0];
      return {
        hasAnonymousUsage: Number(trial.used_trial_credits || 0) > 0,
        used: Number(trial.used_trial_credits || 0),
        limit: Number(trial.total_trial_credits || 0) || getAnonymousTrialLimit(),
        status: trial.status || null,
        source: 'site_trials'
      };
    }

    if (error && !isMissingSchemaError(error)) {
      logger.warn('[anonymousTrial] site trial continuity lookup failed', {
        site_id: siteId,
        error: error.message
      });
    }
  }

  const legacyUsed = await countLegacyAnonymousUsage(supabase, { siteHash });
  if (legacyUsed !== null && legacyUsed !== undefined && Number.isFinite(Number(legacyUsed))) {
    return {
      hasAnonymousUsage: legacyUsed > 0,
      used: legacyUsed,
      limit: getAnonymousTrialLimit(),
      status: legacyUsed >= getAnonymousTrialLimit() ? 'exhausted' : 'active',
      source: 'trial_usage'
    };
  }

  return {
    hasAnonymousUsage: false,
    used: 0,
    limit: getAnonymousTrialLimit(),
    status: null,
    source: 'none'
  };
}

module.exports = {
  buildAnonymousTrialStatus,
  countLegacyAnonymousUsage,
  getAnonymousQuotaState,
  getAnonymousTrialContinuity,
  getAnonymousTrialLimit,
  getAnonymousTrialStatus,
  isMissingSchemaError
};
