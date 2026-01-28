const { getLimits } = require('./license');
const logger = require('../lib/logger');

/**
 * Calculate reset date and quota status for a license.
 * IMPORTANT: If siteHash is provided, looks up the site's actual license to ensure
 * all WordPress users on the same site share the same quota.
 */
async function getQuotaStatus(supabase, { licenseKey, siteHash }) {
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
          requested_license: licenseKey?.substring(0, 8) + '...',
          site_license: site.license_key.substring(0, 8) + '...'
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
    return { error: 'INVALID_LICENSE', status: 401, message: 'License not found' };
  }

  const limits = getLimits(license.plan);
  const periodStart = computePeriodStart(license.billing_day_of_month, now);
  const periodEnd = new Date(periodStart);
  periodEnd.setMonth(periodEnd.getMonth() + 1);

  // Prefer quota_summaries if present
  const { data: summary } = await supabase
    .from('quota_summaries')
    .select('*')
    .eq('license_key', license.license_key)
    .eq('period_start', periodStart.toISOString())
    .maybeSingle();

  const totalLimit = limits.credits;

  // If no summary exists, count usage directly from usage_logs
  let creditsUsed = summary?.total_credits_used || 0;
  let siteUsageFromLogs = {};

  if (!summary || summary.total_credits_used === 0) {
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

    logger.info('[Quota] Fallback usage query', {
      siteHash: siteHash || 'none',
      license_key: license.license_key.substring(0, 8) + '...',
      period_start: periodStart.toISOString(),
      period_end: periodEnd.toISOString(),
      logs_found: usageLogs?.length || 0,
      error: usageError?.message || null
    });

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
    }
  }

  const creditsRemaining = Math.max(totalLimit - creditsUsed, 0);

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
  const isNearLimit = creditsUsed / totalLimit >= warningThreshold;

  return {
    plan_type: license.plan,
    license_status: license.status,
    credits_used: creditsUsed,
    credits_remaining: creditsRemaining,
    total_limit: totalLimit,
    reset_date: periodEnd.toISOString(),
    warning_threshold: warningThreshold,
    is_near_limit: isNearLimit,
    site_quota: siteQuota
  };
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
      status: 402,
      message: 'Quota exceeded',
      credits_used: status.credits_used,
      total_limit: status.total_limit,
      reset_date: status.reset_date
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
  checkQuotaAvailable,
  enforceQuota,
  computePeriodStart
};
