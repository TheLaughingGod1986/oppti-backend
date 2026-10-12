const {
  reserveSiteCredits,
  finalizeSiteGeneration,
  getSiteQuotaStatus,
  hashRequestFingerprint
} = require('./siteQuota');

// Internal linking draws from the SAME shared credit wallet as alt-text and
// titles (site_quotas via bbai_reserve_site_generation). There is no separate
// linking pool — we only tag the ledger with feature_type='internal_linking'
// so usage can be attributed per feature in reporting.
const LINKING_FEATURE_TYPE = 'internal_linking';

/**
 * Reserve credits for an internal-linking opportunities request from the
 * SHARED site_quotas wallet.
 */
async function reserveLinkingGenerationQuota(supabase, {
  account = null,
  licenseKey = null,
  siteIdentity,
  creditsNeeded = 1,
  idempotencyKey = null,
  requestFingerprint = null,
  requestMetadata = {},
  requestId = null
} = {}) {
  return reserveSiteCredits(supabase, {
    account,
    licenseKey,
    siteIdentity,
    creditsNeeded,
    quotaMode: 'site',
    idempotencyKey,
    requestFingerprint,
    requestMetadata: {
      ...requestMetadata,
      feature_type: LINKING_FEATURE_TYPE
    },
    requestId
  });
}

/**
 * Finalize (confirm or release) a linking reservation on the shared wallet.
 */
async function finalizeLinkingGenerationQuota(supabase, {
  generationRequestId,
  success,
  finalMetadata = {}
} = {}) {
  return finalizeSiteGeneration(supabase, {
    generationRequestId,
    success,
    finalMetadata: {
      ...finalMetadata,
      feature_type: LINKING_FEATURE_TYPE
    }
  });
}

/**
 * Read-only snapshot of the SHARED wallet, shaped for linking entitlement_state.
 */
async function getLinkingQuotaStatus(supabase, {
  account = null,
  licenseKey = null,
  siteIdentity,
  requestId = null
} = {}) {
  const status = await getSiteQuotaStatus(supabase, {
    account,
    licenseKey,
    siteIdentity,
    createIfMissing: false,
    quotaMode: 'site',
    requestId
  });

  if (status.error) {
    return {
      error: status.error,
      status: status.status || 500,
      message: status.message || 'Could not load shared quota'
    };
  }

  return {
    feature_type: LINKING_FEATURE_TYPE,
    site_id: status.site?.id || null,
    credits_used: status.credits_used,
    credits_remaining: status.credits_remaining,
    total_limit: status.total_limit,
    daily_used: null,
    daily_limit: null,
    daily_remaining: null,
    plan: status.plan_type || 'free',
    reset_date: status.reset_date || null,
    usage_by_feature: status.usage_by_feature || {},
    source: 'site_quotas_shared'
  };
}

function buildLinkingRequestFingerprint({
  siteKey,
  userInfo,
  targets,
  sources,
  maxSuggestions
}) {
  return hashRequestFingerprint({
    site_hash: siteKey || null,
    wp_install_uuid: siteKey || null,
    user_id: userInfo?.user_id || null,
    user_email: userInfo?.user_email || null,
    feature: LINKING_FEATURE_TYPE,
    target_ids: (targets || []).map((p) => String(p?.id ?? '')).filter(Boolean).sort(),
    source_ids: (sources || []).map((p) => String(p?.id ?? '')).filter(Boolean).sort(),
    max_suggestions: maxSuggestions || null
  });
}

module.exports = {
  LINKING_FEATURE_TYPE,
  reserveLinkingGenerationQuota,
  finalizeLinkingGenerationQuota,
  getLinkingQuotaStatus,
  buildLinkingRequestFingerprint
};
