const {
  reserveSiteCredits,
  finalizeSiteGeneration,
  getSiteQuotaStatus,
  hashRequestFingerprint
} = require('./siteQuota');

// Internal linking draws from the SAME shared `site_quotas` wallet as alt-text
// and titles (via the `bbai_reserve_site_generation` RPC). It has no pool of
// its own; we only tag the ledger with feature_type='internal_linking' so usage
// can be attributed per feature. This mirrors services/titleQuota.js so the
// route keeps the familiar reserve → finalize shape while spending shared
// credits. The alt-text and titles reservation paths are untouched.
const INTERNAL_LINKING_FEATURE_TYPE = 'internal_linking';

/**
 * Reserve credits for an internal-linking suggestion request from the shared
 * wallet. `creditsNeeded` defaults to 1 (one analysis of a source page).
 */
async function reserveInternalLinkingQuota(supabase, {
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
      feature_type: INTERNAL_LINKING_FEATURE_TYPE
    },
    requestId
  });
}

/**
 * Finalize (confirm or release) an internal-linking reservation.
 */
async function finalizeInternalLinkingQuota(supabase, {
  generationRequestId,
  success,
  finalMetadata = {}
} = {}) {
  return finalizeSiteGeneration(supabase, {
    generationRequestId,
    success,
    finalMetadata: {
      ...finalMetadata,
      feature_type: INTERNAL_LINKING_FEATURE_TYPE
    }
  });
}

/**
 * Read-only snapshot of the shared wallet, shaped as `entitlement_state`.
 */
async function getInternalLinkingQuotaStatus(supabase, {
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
    feature_type: INTERNAL_LINKING_FEATURE_TYPE,
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

function buildInternalLinkingRequestFingerprint({
  siteKey,
  userInfo,
  source,
  candidates = [],
  options = {}
}) {
  return hashRequestFingerprint({
    site_hash: siteKey || null,
    wp_install_uuid: siteKey || null,
    user_id: userInfo?.user_id || null,
    user_email: userInfo?.user_email || null,
    feature: INTERNAL_LINKING_FEATURE_TYPE,
    source_url: source?.url || null,
    candidate_urls: candidates.map((c) => c?.url || c?.id || null),
    options: options || {}
  });
}

module.exports = {
  INTERNAL_LINKING_FEATURE_TYPE,
  reserveInternalLinkingQuota,
  finalizeInternalLinkingQuota,
  getInternalLinkingQuotaStatus,
  buildInternalLinkingRequestFingerprint
};
