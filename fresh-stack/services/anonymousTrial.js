const logger = require('../lib/logger');

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

function isMissingSchemaError(error) {
  if (!error) return false;
  return ['42P01', '42703', '42883'].includes(error.code) || /does not exist|not exist|undefined function/i.test(error.message || '');
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

  return {
    trial_used: normalizedUsed,
    trial_remaining: remaining,
    trial_exhausted: exhausted,
    trial_limit: normalizedLimit,
    signup_required: exhausted,
    anon_id: anonId || null,
    anonymous: {
      anon_id: anonId || null,
      used: normalizedUsed,
      remaining,
      total: normalizedLimit,
      signup_required: exhausted
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
    return buildAnonymousTrialStatus({
      used: usedFromV2,
      limit: Number.isFinite(limitFromV2) && limitFromV2 > 0 ? limitFromV2 : getAnonymousTrialLimit(),
      anonId
    });
  }

  const used = await countLegacyAnonymousUsage(supabase, { siteHash });
  if (!Number.isFinite(Number(used))) {
    return null;
  }

  return buildAnonymousTrialStatus({
    used,
    limit: getAnonymousTrialLimit(),
    anonId
  });
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
  if (Number.isFinite(Number(legacyUsed))) {
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
  getAnonymousTrialContinuity,
  getAnonymousTrialLimit,
  getAnonymousTrialStatus,
  isMissingSchemaError
};
