const {
  reserveSiteCredits,
  finalizeSiteGeneration,
  getSiteQuotaStatus,
  hashRequestFingerprint
} = require('./siteQuota');

// Titles and alt-text share one credit wallet. The titles feature does NOT
// have its own pool — every title/meta generation reserves from the same
// `site_quotas` balance the alt-text plugin uses (via the shared
// `bbai_reserve_site_generation` RPC). We only tag the ledger with
// feature_type='title_meta' so usage can be attributed per feature.
//
// This module is a thin adapter over services/siteQuota.js so the titles
// route + bulk worker keep their existing call sites unchanged while drawing
// down the shared wallet. The alt-text reservation path is untouched.
const TITLES_FEATURE_TYPE = 'title_meta';

/**
 * Reserve credits for a title/meta generation from the SHARED site_quotas
 * wallet. `creditsNeeded` is the number of fields being generated
 * (title = 1, meta = 1, both = 2). Returns the same shape as
 * reserveSiteCredits: { error, status, message, payload, site } on failure,
 * { error: null, site, account, reservation } on success.
 */
async function reserveTitleGenerationQuota(supabase, {
  account = null,
  licenseKey = null,
  siteIdentity,
  creditsNeeded = 2,
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
      feature_type: TITLES_FEATURE_TYPE
    },
    requestId
  });
}

/**
 * Finalize (confirm or release) a title reservation on the shared wallet.
 */
async function finalizeTitleGenerationQuota(supabase, {
  generationRequestId,
  success,
  finalMetadata = {}
} = {}) {
  return finalizeSiteGeneration(supabase, {
    generationRequestId,
    success,
    finalMetadata: {
      ...finalMetadata,
      feature_type: TITLES_FEATURE_TYPE
    }
  });
}

/**
 * Read-only snapshot of the SHARED wallet, shaped as titles `entitlement_state`.
 * The numbers here are the same balance alt-text reports — that is the point:
 * credits spent on alt-text reduce what's available for titles and vice versa.
 */
async function getTitleQuotaStatus(supabase, {
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
    feature_type: TITLES_FEATURE_TYPE,
    site_id: status.site?.id || null,
    credits_used: status.credits_used,
    credits_remaining: status.credits_remaining,
    total_limit: status.total_limit,
    // The shared free wallet has no daily sub-cap (see migration 017), so daily
    // fields are intentionally null — the plugin treats null as "no daily limit".
    daily_used: null,
    daily_limit: null,
    daily_remaining: null,
    plan: status.plan_type || 'free',
    reset_date: status.reset_date || null,
    // Per-plugin attribution of the shared wallet for this cycle (sums to
    // credits_used). The plugin's Settings "Credit usage" card renders this.
    usage_by_feature: status.usage_by_feature || {},
    source: 'site_quotas_shared'
  };
}

function buildTitleRequestFingerprint({
  siteKey,
  userInfo,
  page,
  options,
  previous,
  jobId = null,
  itemId = null
}) {
  return hashRequestFingerprint({
    site_hash: siteKey || null,
    wp_install_uuid: siteKey || null,
    user_id: userInfo?.user_id || null,
    user_email: userInfo?.user_email || null,
    feature: TITLES_FEATURE_TYPE,
    page_url: page?.url || null,
    page_h1: page?.h1 || null,
    options: options || {},
    regenerate: Boolean(previous && (previous.title || previous.meta)),
    bulk_job_id: jobId,
    item_id: itemId
  });
}

module.exports = {
  TITLES_FEATURE_TYPE,
  reserveTitleGenerationQuota,
  finalizeTitleGenerationQuota,
  getTitleQuotaStatus,
  buildTitleRequestFingerprint
};
