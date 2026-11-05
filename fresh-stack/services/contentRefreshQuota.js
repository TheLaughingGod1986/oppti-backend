const {
  reserveSiteCredits,
  finalizeSiteGeneration,
  getSiteQuotaStatus,
  hashRequestFingerprint
} = require('./siteQuota');

// Content Refresh draws from the SAME shared `site_quotas` wallet as alt-text,
// titles and internal linking. We only tag the ledger with
// feature_type='content_refresh' so usage can be attributed per feature.
const CONTENT_REFRESH_FEATURE_TYPE = 'content_refresh';

/**
 * Reserve credits for a content-refresh suggestion request from the shared
 * wallet. `creditsNeeded` defaults to 1 (one analysis of a source page).
 */
async function reserveContentRefreshQuota(supabase, {
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
      feature_type: CONTENT_REFRESH_FEATURE_TYPE
    },
    requestId
  });
}

/**
 * Finalize (confirm or release) a content-refresh reservation.
 */
async function finalizeContentRefreshQuota(supabase, {
  generationRequestId,
  success,
  finalMetadata = {}
} = {}) {
  return finalizeSiteGeneration(supabase, {
    generationRequestId,
    success,
    finalMetadata: {
      ...finalMetadata,
      feature_type: CONTENT_REFRESH_FEATURE_TYPE
    }
  });
}

/**
 * Read-only snapshot of the shared wallet, shaped as `entitlement_state`.
 */
async function getContentRefreshQuotaStatus(supabase, {
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
    feature_type: CONTENT_REFRESH_FEATURE_TYPE,
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

function buildContentRefreshRequestFingerprint({
  siteKey,
  userInfo,
  post = {},
  options = {}
}) {
  return hashRequestFingerprint({
    site_hash: siteKey || null,
    wp_install_uuid: siteKey || null,
    user_id: userInfo?.user_id || null,
    user_email: userInfo?.user_email || null,
    feature: CONTENT_REFRESH_FEATURE_TYPE,
    post_id: post?.id ?? null,
    post_url: post?.url || null,
    content_hash: typeof post?.content_excerpt === 'string'
      ? post.content_excerpt.slice(0, 64)
      : null,
    decay_score: post?.decay_score ?? null,
    options: options || {}
  });
}

module.exports = {
  CONTENT_REFRESH_FEATURE_TYPE,
  reserveContentRefreshQuota,
  finalizeContentRefreshQuota,
  getContentRefreshQuotaStatus,
  buildContentRefreshRequestFingerprint
};
