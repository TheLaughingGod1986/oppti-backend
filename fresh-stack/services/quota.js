const { getLimits } = require('./planLimits');
const logger = require('../lib/logger');
const { serializeSupabaseError } = require('../lib/supabaseErrors');
const {
  buildSiteIdentity,
  finalizeSiteGeneration,
  getSiteQuotaStatus,
  reserveSiteCredits
} = require('./siteQuota');

function logV2Fallback(message, details = {}) {
  logger.warn(`[V2_FALLBACK] ${message}`, details);
}

function maskLicenseKeyForAudit(licenseKey) {
  if (!licenseKey) return null;
  const normalized = String(licenseKey);
  return normalized.length > 8 ? `${normalized.substring(0, 8)}...` : '[redacted]';
}

function toAuditIsoString(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}

function toAuditNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function logCreditsAudit(message, details = {}, level = 'info') {
  logger[level](`[bbai-credits] ${message}`, details);
}

function buildRowsFoundAuditPayload(details = {}, error = null) {
  const rowsFound = toAuditNumber(details.rows_found, 0);
  const payload = {
    ...details,
    rows_found: rowsFound,
    status: error ? 'error' : (rowsFound > 0 ? 'ok' : 'no_rows')
  };

  if (!error && rowsFound === 0) {
    // rows_found: 0 is not an error. It means no matching usage rows were found for that lookup path.
    payload.reason = details.reason || 'no_matching_usage_rows';
  }

  if (error) {
    const serialized = serializeSupabaseError(error);
    payload.error = serialized;
    payload.error_message = serialized?.message || error.message || null;
    if (serialized?.code || error.code) {
      payload.error_code = serialized?.code || error.code;
    }
  }

  return payload;
}

const FREE_DAILY_GENERATION_LIMIT = getLimits('free').dailyCredits || 5;

function getDailyQuotaWindow(now = new Date()) {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0));
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 1);
  return {
    start: start.toISOString(),
    end: end.toISOString()
  };
}

async function withDailyFreeAllowance(supabase, status, { siteHash = null, licenseKey = null } = {}) {
  if (!status || status.error || String(status.plan_type || '').toLowerCase() !== 'free') {
    return status;
  }

  const window = getDailyQuotaWindow();
  let query = supabase
    .from('usage_logs')
    .select('credits_used')
    .eq('status', 'success')
    .gte('created_at', window.start)
    .lt('created_at', window.end);
  const effectiveSiteHash = status.site?.site_hash || status.site_quota?.site_hash || siteHash;
  if (effectiveSiteHash) {
    query = query.eq('site_hash', effectiveSiteHash);
  } else if (licenseKey) {
    query = query.eq('license_key', licenseKey);
  }

  const { data, error } = await query;
  if (error) {
    logger.warn('[Quota] Unable to resolve daily free usage; retaining monthly decision', {
      site_hash: effectiveSiteHash || null,
      error: serializeSupabaseError(error)
    });
    return status;
  }

  const used = (Array.isArray(data) ? data : [])
    .reduce((sum, row) => sum + Math.max(Number(row?.credits_used) || 1, 0), 0);
  const remaining = Math.max(FREE_DAILY_GENERATION_LIMIT - used, 0);
  const monthlyExhausted = Number(status.credits_remaining) <= 0;

  return {
    ...status,
    daily_generation_limit: FREE_DAILY_GENERATION_LIMIT,
    daily_generations_used: used,
    daily_generations_remaining: remaining,
    daily_reset_date: window.end,
    quota_state: monthlyExhausted ? 'exhausted' : (remaining <= 0 ? 'daily_exhausted' : status.quota_state)
  };
}

/**
 * Calculate reset date and quota status for a license.
 * IMPORTANT: If siteHash is provided, looks up the site's actual license to ensure
 * all WordPress users on the same site share the same quota.
 */
async function getLegacyQuotaStatus(supabase, {
  licenseKey,
  siteHash,
  requestId = null,
  accountId = null
} = {}) {
  const now = new Date();

  // If siteHash provided, look up the site's actual license for credit sharing
  // This ensures all users on a WordPress site share the same quota
  let effectiveLicenseKey = licenseKey;
  if (siteHash) {
    const { data: site } = await supabase
      .from('sites')
      .select('license_key')
      .eq('site_hash', siteHash)
      .eq('status', 'active')
      .maybeSingle();

    if (site?.license_key) {
      // Use the site's license key for quota tracking
      if (site.license_key !== licenseKey) {
        logger.info('[Quota] Using site license for credit sharing', {
          site_hash: siteHash,
          requested_license: maskLicenseKeyForAudit(licenseKey),
          site_license: maskLicenseKeyForAudit(site.license_key)
        });
      }
      effectiveLicenseKey = site.license_key;
    }
  }

  const { data: license, error: licenseError } = await supabase
    .from('licenses')
    .select('*')
    .eq('license_key', effectiveLicenseKey)
    .single();

  if (licenseError || !license) {
    return { error: 'INVALID_LICENSE', code: 'INVALID_LICENSE', status: 401, message: 'License not found' };
  }

  const limits = getLimits(license.plan);
  const periodStart = computePeriodStart(license.billing_day_of_month, now);
  const periodEnd = new Date(periodStart);
  periodEnd.setMonth(periodEnd.getMonth() + 1);

  const auditContext = {
    request_id: requestId || null,
    account_id: accountId || null,
    license_id_prefix: maskLicenseKeyForAudit(license.id),
    license_key_prefix: maskLicenseKeyForAudit(license.license_key),
    site_id: null,
    site_hash: siteHash || null,
    period_start: toAuditIsoString(periodStart),
    period_end: toAuditIsoString(periodEnd)
  };

  logCreditsAudit('period_selected', {
    ...auditContext,
    source_path: 'legacy',
    lookup_key: siteHash ? 'site_hash' : 'license_key'
  });

  // Prefer quota_summaries if present
  const { data: summary, error: summaryError } = await supabase
    .from('quota_summaries')
    .select('*')
    .eq('license_key', license.license_key)
    .eq('period_start', periodStart.toISOString())
    .maybeSingle();

  logCreditsAudit('rows_found', buildRowsFoundAuditPayload({
    ...auditContext,
    source_candidate: 'quota_summaries',
    lookup_key: 'license_key+period_start',
    rows_found: summary ? 1 : 0,
    credits_used_candidate: toAuditNumber(summary?.total_credits_used, 0)
  }, summaryError), summaryError ? 'warn' : 'info');

  const totalLimit = limits.credits;

  // If no summary exists, count usage directly from usage_logs
  let creditsUsed = summary?.total_credits_used || 0;
  let siteUsageFromLogs = {};
  let selectedSource = summary ? 'quota_summaries' : 'fallback/default path';
  let fallbackReason = summary ? null : 'quota_summary_missing';
  const checkedSources = ['quota_summaries'];

  if (!summary || summary.total_credits_used === 0) {
    checkedSources.push('usage_logs');
    // Fallback: aggregate from usage_logs for this billing period
    // For credit sharing: query by site_hash if available, otherwise by license_key
    let usageQuery = supabase
      .from('usage_logs')
      .select('credits_used, site_hash, license_key')
      .gte('created_at', periodStart.toISOString())
      .lt('created_at', periodEnd.toISOString());

    if (siteHash) {
      // Query by site_hash to get ALL usage for the site (credit sharing)
      usageQuery = usageQuery.eq('site_hash', siteHash);
    } else {
      // No site context, query by license_key
      usageQuery = usageQuery.eq('license_key', license.license_key);
    }

    const { data: usageLogs, error: usageError } = await usageQuery;

    const usageRowsFound = Array.isArray(usageLogs) ? usageLogs.length : 0;
    const usageCredits = Array.isArray(usageLogs)
      ? usageLogs.reduce((sum, log) => sum + toAuditNumber(log?.credits_used, 1), 0)
      : 0;

    const quotaLogData = {
      siteHash: siteHash || 'none',
      license_key_prefix: maskLicenseKeyForAudit(license.license_key),
      period_start: periodStart.toISOString(),
      period_end: periodEnd.toISOString(),
      logs_found: usageLogs?.length || 0
    };
    if (usageError) {
      quotaLogData.error = usageError.message;
      logger.error('[Quota] Fallback usage query failed', quotaLogData);
    } else {
      logger.info('[Quota] Fallback usage query', quotaLogData);
    }

    logCreditsAudit('rows_found', buildRowsFoundAuditPayload({
      ...auditContext,
      source_candidate: 'usage_logs',
      lookup_key: siteHash ? 'site_hash' : 'license_key',
      rows_found: usageRowsFound,
      credits_used_candidate: usageCredits
    }, usageError), usageError ? 'warn' : 'info');

    if (usageLogs && usageLogs.length > 0) {
      creditsUsed = usageLogs.reduce((sum, log) => sum + (log.credits_used || 1), 0);
      // Build site usage map
      usageLogs.forEach((log) => {
        if (log.site_hash) {
          siteUsageFromLogs[log.site_hash] = (siteUsageFromLogs[log.site_hash] || 0) + (log.credits_used || 1);
        }
      });
      logger.info('[Quota] Aggregated usage from logs', {
        query_by: siteHash ? 'site_hash' : 'license_key',
        credits_used: creditsUsed,
        log_count: usageLogs.length
      });
      selectedSource = 'usage_logs';
      fallbackReason = !summary
        ? 'quota_summary_missing'
        : 'quota_summary_zero';
    } else if (usageError) {
      selectedSource = 'fallback/default path';
      fallbackReason = `usage_logs_query_failed:${usageError.code || usageError.message || 'unknown'}`;
    } else {
      selectedSource = 'fallback/default path';
      fallbackReason = !summary
        ? 'quota_summary_missing_and_usage_logs_empty'
        : 'quota_summary_zero_and_usage_logs_empty';
    }
  }

  const creditsRemaining = Math.max(totalLimit - creditsUsed, 0);
  const effectiveTotalLimit = totalLimit;

  let siteQuota = null;
  if (siteHash) {
    const siteUsage = summary?.site_usage || siteUsageFromLogs;
    const usedBySite = Number(siteUsage[siteHash] || 0);
    siteQuota = {
      site_hash: siteHash,
      credits_used: usedBySite,
      quota_limit: null,
      quota_remaining: null
    };
    if (license.plan === 'agency') {
      const { data: site } = await supabase
        .from('sites')
        .select('quota_limit')
        .eq('site_hash', siteHash)
        .maybeSingle();
      const limit = site?.quota_limit || null;
      siteQuota.quota_limit = limit;
      siteQuota.quota_remaining = limit != null ? Math.max(limit - usedBySite, 0) : null;
    }
  }

  const warningThreshold = 0.9;
  const isNearLimit = creditsUsed / effectiveTotalLimit >= warningThreshold;

  logCreditsAudit('source_selected', {
    ...auditContext,
    source_selected: selectedSource,
    selected_source: selectedSource,
    checked_sources: checkedSources,
    used: toAuditNumber(creditsUsed, 0),
    limit: toAuditNumber(effectiveTotalLimit, 0),
    remaining: toAuditNumber(creditsRemaining, 0),
    fallback_reason: fallbackReason
  });

  return {
    plan_type: license.plan,
    license_status: license.status,
    token_limit: effectiveTotalLimit,
    tokens_used_this_month: creditsUsed,
    total_tokens_used: license.total_tokens_used ?? creditsUsed,
    last_generation_at: license.last_generation_at || null,
    credits_used: creditsUsed,
    credits_remaining: creditsRemaining,
    total_limit: effectiveTotalLimit,
    reset_date: periodEnd.toISOString(),
    warning_threshold: warningThreshold,
    is_near_limit: isNearLimit,
    site_quota: siteQuota
  };
}

async function getQuotaStatus(supabase, {
  licenseKey,
  siteHash,
  siteUrl,
  siteFingerprint,
  installUuid,
  account,
  requestId,
  quotaMode = 'site',
  siteIdentity: prebuiltIdentity
} = {}) {
  const hasSiteSignals = Boolean(siteHash || siteUrl || siteFingerprint || installUuid || prebuiltIdentity);

  logCreditsAudit('input_identity', {
    request_id: requestId || null,
    account_id: account?.id || null,
    license_key_prefix: maskLicenseKeyForAudit(licenseKey || account?.license_key || null),
    site_hash: siteHash || prebuiltIdentity?.siteHash || null,
    site_url: siteUrl || prebuiltIdentity?.siteUrl || null,
    site_fingerprint_present: Boolean(siteFingerprint || prebuiltIdentity?.siteFingerprint),
    install_uuid: installUuid || prebuiltIdentity?.wpInstallUuid || null,
    quota_mode: quotaMode,
    has_site_signals: hasSiteSignals
  });

  if (!hasSiteSignals) {
    return withDailyFreeAllowance(supabase, await getLegacyQuotaStatus(supabase, {
      licenseKey,
      siteHash,
      requestId,
      accountId: account?.id || null
    }), { siteHash, licenseKey });
  }

  const hasAuthenticatedSiteContext = Boolean(
    account?.id
    || account?.license_key
    || licenseKey
  );
  const isTrialQuotaMode = quotaMode === 'trial';

  // Use the caller-provided siteIdentity if available (preserves allowDevelopment
  // flag set at the route level), otherwise build a fresh one.
  const identity = prebuiltIdentity || buildSiteIdentity({
    siteHash,
    siteUrl,
    siteFingerprint,
    installUuid,
    allowDevelopment: Boolean(isTrialQuotaMode || hasAuthenticatedSiteContext)
  });
  if (identity?.error === 'DEVELOPMENT_SITE_NOT_ALLOWED') {
    logCreditsAudit('fallback_reason', {
      request_id: requestId || null,
      account_id: account?.id || null,
      license_id_prefix: maskLicenseKeyForAudit(account?.id || null),
      license_key_prefix: maskLicenseKeyForAudit(licenseKey || account?.license_key || null),
      site_id: identity?.siteId || null,
      site_hash: siteHash || identity.siteHash || null,
      source_selected: 'fallback/default path',
      selected_source: 'fallback/default path',
      checked_sources: ['site_quotas'],
      fallback_reason: 'development_site_not_allowed'
    }, 'warn');
    return withDailyFreeAllowance(supabase, await getLegacyQuotaStatus(supabase, {
      licenseKey,
      siteHash: siteHash || identity.siteHash,
      requestId,
      accountId: account?.id || null
    }), { siteHash: siteHash || identity.siteHash, licenseKey });
  }

  const siteStatus = await getSiteQuotaStatus(supabase, {
    account,
    licenseKey,
    siteIdentity: identity,
    createIfMissing: hasAuthenticatedSiteContext || isTrialQuotaMode,
    quotaMode,
    requestId
  });

  if (!siteStatus.error) {
    return withDailyFreeAllowance(supabase, siteStatus, {
      siteHash: siteHash || identity.siteHash,
      licenseKey: licenseKey || account?.license_key || null
    });
  }

  if (hasAuthenticatedSiteContext) {
    logger.error('[site] authenticated_site_healing_failed', {
      request_id: requestId || null,
      account_id: account?.id || null,
      license_key_prefix: maskLicenseKeyForAudit(licenseKey),
      site_hash: siteHash || identity?.siteHash || null,
      site_url: siteUrl || identity?.siteUrl || null,
      site_fingerprint_present: Boolean(siteFingerprint || identity?.siteFingerprint),
      error: siteStatus.error,
      message: siteStatus.message || null
    });
  }

  if (isTrialQuotaMode) {
    logV2Fallback('Trial quota status V2 path failed; using legacy trial fallback', {
      v2_error_code: siteStatus.error,
      v2_error_message: siteStatus.message || null,
      fallback_reason: `site_quota_v2:${siteStatus.error}`,
      selected_source: 'legacy_trial',
      checked_sources: ['site_quotas'],
      site_id: identity?.siteId || null,
      site_hash: siteHash || identity?.siteHash || null,
      license_id_prefix: maskLicenseKeyForAudit(account?.id || null),
      license_key_prefix: maskLicenseKeyForAudit(licenseKey || account?.license_key || null),
      request_id: requestId || null
    });
    return siteStatus;
  }

  if (siteStatus.error !== 'SITE_QUOTA_V2_UNAVAILABLE' && siteStatus.error !== 'SITE_NOT_FOUND') {
    return siteStatus;
  }

  logV2Fallback('Quota status V2 path failed; using legacy quota status', {
    v2_error_code: siteStatus.error,
    v2_error_message: siteStatus.message || null,
    fallback_reason: `site_quota_v2:${siteStatus.error}`,
    selected_source: 'fallback/default path',
    checked_sources: ['site_quotas'],
    site_id: identity?.siteId || null,
    site_hash: siteHash || identity?.siteHash || null,
    license_id_prefix: maskLicenseKeyForAudit(account?.id || null),
    license_key_prefix: maskLicenseKeyForAudit(licenseKey || account?.license_key || null)
  });
  logCreditsAudit('fallback_reason', {
    request_id: requestId || null,
    account_id: account?.id || null,
    license_id_prefix: maskLicenseKeyForAudit(account?.id || null),
    license_key_prefix: maskLicenseKeyForAudit(licenseKey || account?.license_key || null),
    site_id: identity?.siteId || null,
    site_hash: siteHash || identity?.siteHash || null,
    source_selected: 'fallback/default path',
    selected_source: 'fallback/default path',
    checked_sources: ['site_quotas'],
    fallback_reason: `site_quota_v2:${siteStatus.error}`
  }, 'warn');
  return withDailyFreeAllowance(supabase, await getLegacyQuotaStatus(supabase, {
    licenseKey,
    siteHash: siteHash || identity?.siteHash,
    requestId,
    accountId: account?.id || null
  }), { siteHash: siteHash || identity?.siteHash, licenseKey });
}

/**
 * Check if enough credits remain; does not mutate.
 */
async function checkQuotaAvailable(supabase, { licenseKey, siteHash, creditsNeeded = 1 }) {
  const status = await getQuotaStatus(supabase, { licenseKey, siteHash });
  if (status.error) return status;
  if (status.credits_remaining < creditsNeeded) {
    return {
      error: 'QUOTA_EXCEEDED',
      code: 'QUOTA_EXCEEDED',
      status: 402,
      message: 'Quota exceeded',
      credits_used: status.credits_used,
      total_limit: status.total_limit,
      reset_date: status.reset_date
    };
  }
  if (status.daily_generations_remaining != null && status.daily_generations_remaining < creditsNeeded) {
    return {
      error: 'DAILY_QUOTA_EXCEEDED',
      code: 'DAILY_QUOTA_EXCEEDED',
      status: 402,
      message: 'Daily free generation limit reached',
      credits_used: status.credits_used,
      credits_remaining: status.credits_remaining,
      total_limit: status.total_limit,
      reset_date: status.reset_date,
      daily_generation_limit: status.daily_generation_limit,
      daily_generations_used: status.daily_generations_used,
      daily_generations_remaining: status.daily_generations_remaining,
      daily_reset_date: status.daily_reset_date
    };
  }
  return status;
}

/**
 * Enforce quota; throws on failure to simplify route handlers.
 */
async function enforceQuota(supabase, { licenseKey, siteHash, creditsNeeded = 1 }) {
  const skipList = (process.env.SKIP_QUOTA_CHECK_SITE_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (siteHash && skipList.includes(siteHash)) {
    return {
      plan_type: 'skip',
      license_status: 'active',
      credits_used: 0,
      credits_remaining: Number.MAX_SAFE_INTEGER,
      total_limit: Number.MAX_SAFE_INTEGER,
      reset_date: null,
      warning_threshold: 0,
      is_near_limit: false,
      site_quota: { site_hash: siteHash, credits_used: 0 }
    };
  }

  const result = await checkQuotaAvailable(supabase, { licenseKey, siteHash, creditsNeeded });
  if (result.error) {
    const err = new Error(result.message);
    err.status = result.status;
    err.code = result.error;
    err.payload = result;
    throw err;
  }
  return result;
}

async function reserveGenerationQuota(supabase, {
  account = null,
  licenseKey = null,
  siteHash = null,
  siteUrl = null,
  siteFingerprint = null,
  installUuid = null,
  creditsNeeded = 1,
  quotaMode = 'site',
  idempotencyKey = null,
  requestFingerprint = null,
  requestMetadata = {},
  requestId = null,
  siteIdentity: prebuiltIdentity = null
} = {}) {
  const effectiveSiteHash = siteHash || prebuiltIdentity?.siteHash;
  const skipList = (process.env.SKIP_QUOTA_CHECK_SITE_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  if (effectiveSiteHash && skipList.includes(effectiveSiteHash)) {
    return {
      error: null,
      reservation: {
        ok: true,
        status: 'reserved',
        generation_request_id: null,
        remaining_credits: Number.MAX_SAFE_INTEGER,
        total_limit: Number.MAX_SAFE_INTEGER,
        credits_used: 0,
        quota_source: quotaMode === 'trial' ? 'trial' : 'site_quota',
        plan: 'skip'
      },
      site: null,
      account
    };
  }

  if (quotaMode === 'site') {
    const available = await checkQuotaAvailable(supabase, {
      licenseKey: licenseKey || account?.license_key || null,
      siteHash: effectiveSiteHash,
      creditsNeeded
    });
    if (available.error) {
      return {
        error: available.error,
        code: available.error,
        status: available.status,
        message: available.message,
        payload: available
      };
    }
  }

  // Use the caller-provided siteIdentity if available (preserves allowDevelopment
  // flag set at the route level), otherwise build a fresh one.
  const identity = prebuiltIdentity || buildSiteIdentity({
    siteHash,
    siteUrl,
    siteFingerprint,
    installUuid
  });

  const result = await reserveSiteCredits(supabase, {
    account,
    licenseKey,
    siteIdentity: identity,
    creditsNeeded,
    quotaMode,
    idempotencyKey,
    requestFingerprint,
    requestMetadata,
    requestId
  });

  if (!result.error) {
    logger.info('[Quota] Generation reservation succeeded', {
      site_hash: result.site?.site_hash || effectiveSiteHash || null,
      site_id: result.site?.id || null,
      quota_mode: quotaMode,
      quota_source: result.reservation?.quota_source || null,
      generation_request_id: result.reservation?.generation_request_id || null,
      created_site: Boolean(result.created),
      matched_by: result.matchedBy || null,
      request_id: requestId || null
    });
    return result;
  }

  logger.warn('[Quota] Generation reservation returned non-success', {
    site_hash: effectiveSiteHash || identity?.siteHash || null,
    quota_mode: quotaMode,
    error_code: result.error,
    error_message: result.message || null,
    request_id: requestId || null
  });

  // For trial mode, any V2 error is recoverable — fall back to legacy trial
  // tracking (trial_usage table). The V2 RPC may fail for new trial sites
  // that have no site_trials row yet, or due to constraint violations.
  if (quotaMode === 'trial') {
    if (result.error !== 'TRIAL_EXHAUSTED') {
      logV2Fallback('Trial reservation V2 path failed; using legacy trial fallback', {
        v2_error_code: result.error,
        v2_error_message: result.message || null,
        fallback_reason: `site_quota_v2:${result.error}`,
        selected_source: 'legacy_trial',
        checked_sources: ['site_quotas'],
        site_id: result.site?.id || null,
        site_hash: effectiveSiteHash || identity?.siteHash || null,
        license_id_prefix: maskLicenseKeyForAudit(account?.id || null),
        license_key_prefix: maskLicenseKeyForAudit(licenseKey || account?.license_key || null),
        request_id: requestId || null
      });
      return {
        error: null,
        site: result.site || null,
        account,
        reservation: {
          ok: true,
          status: 'legacy_trial',
          generation_request_id: null,
          remaining_credits: null,
          total_limit: null,
          credits_used: null,
          quota_source: 'legacy_trial',
          plan: 'trial'
        }
      };
    }
    // TRIAL_EXHAUSTED is a real exhaustion — propagate it.
    return result;
  }

  // In production we want V2, but if canonical site resolution/creation fails
  // (eg. transient RLS/schema mismatch or bad identity signals), fall back to
  // legacy license quota rather than hard-failing generation.
  const v2FallbackErrors = new Set([
    'SITE_QUOTA_V2_UNAVAILABLE',
    'SITE_CREATE_FAILED',
    'SITE_NOT_FOUND'
  ]);
  if (!v2FallbackErrors.has(result.error)) {
    return result;
  }

  logV2Fallback('Site reservation V2 path failed; using legacy license quota fallback', {
    v2_error_code: result.error,
    v2_error_message: result.message || null,
    fallback_reason: `site_quota_v2:${result.error}`,
    selected_source: 'legacy',
    checked_sources: ['site_quotas'],
    site_id: result.site?.id || null,
    site_hash: effectiveSiteHash || identity?.siteHash || null,
    license_id_prefix: maskLicenseKeyForAudit(account?.id || null),
    license_key_prefix: maskLicenseKeyForAudit(licenseKey || account?.license_key || null),
    request_id: requestId || null
  });

  const legacy = await checkQuotaAvailable(supabase, { licenseKey, siteHash: effectiveSiteHash, creditsNeeded });
  if (legacy.error) {
    return {
      error: legacy.error,
      code: legacy.error,
      status: legacy.status,
      message: legacy.message,
      payload: legacy
    };
  }

  return {
    error: null,
    site: null,
    account,
    reservation: {
      ok: true,
      status: 'legacy_reserved',
      generation_request_id: null,
      remaining_credits: legacy.credits_remaining,
      total_limit: legacy.total_limit,
      credits_used: legacy.credits_used,
      quota_source: 'legacy',
      plan: legacy.plan_type
    }
  };
}

async function finalizeGenerationQuotaReservation(supabase, {
  generationRequestId,
  success,
  finalMetadata = {}
} = {}) {
  if (!generationRequestId) {
    logger.info('[Quota] Generation finalization skipped', {
      success: Boolean(success),
      reason: 'missing_generation_request_id'
    });
    return { error: null, skipped: true };
  }

  const result = await finalizeSiteGeneration(supabase, {
    generationRequestId,
    success,
    finalMetadata
  });

  if (result.error) {
    logger.warn('[Quota] Generation finalization failed', {
      generation_request_id: generationRequestId,
      success: Boolean(success),
      error: serializeSupabaseError(result.error)
    });
  } else {
    logger.info('[Quota] Generation finalization completed', {
      generation_request_id: generationRequestId,
      success: Boolean(success),
      final_status: result.data?.status || null
    });
  }

  return result;
}

function computePeriodStart(billingDay = 1, now = new Date()) {
  const day = Math.max(1, Math.min(31, Number(billingDay) || 1));
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), day, 0, 0, 0));
  if (now < start) {
    start.setUTCMonth(start.getUTCMonth() - 1);
  }
  return start;
}

module.exports = {
  getQuotaStatus,
  getLegacyQuotaStatus,
  checkQuotaAvailable,
  enforceQuota,
  reserveGenerationQuota,
  finalizeGenerationQuotaReservation,
  computePeriodStart,
  getDailyQuotaWindow,
  withDailyFreeAllowance,
  logV2Fallback
};
