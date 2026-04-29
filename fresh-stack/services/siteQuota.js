const crypto = require('crypto');
const logger = require('../lib/logger');
const { isMissingSchemaError, serializeSupabaseError } = require('../lib/supabaseErrors');
const { buildSiteIdentity } = require('../lib/siteIdentity');
const { getAnonymousTrialLimit } = require('./anonymousTrial');
const { getLimits } = require('./planLimits');

const SITE_SELECT = [
  'id',
  'license_key',
  'site_hash',
  'site_url',
  'site_name',
  'fingerprint',
  'site_fingerprint',
  'wp_install_uuid',
  'normalized_site_url',
  'canonical_domain',
  'status',
  'owner_user_id',
  'merged_into_site_id',
  'first_seen_at',
  'last_seen_at',
  'updated_at'
].join(', ');
const LEGACY_SITE_SELECT = [
  'id',
  'license_key',
  'site_hash',
  'site_url',
  'site_name',
  'fingerprint',
  'status',
  'activated_at',
  'last_activity_at',
  'deactivated_at'
].join(', ');

const ACCOUNT_SELECT = 'id, email, license_key, plan, status, billing_cycle, billing_day_of_month, stripe_customer_id, stripe_subscription_id';
const PLAN_SELECT = 'id, display_name, monthly_included_credits, credit_grant_amount, billing_interval_default, is_paid';
const ROLE_RANK = {
  member: 1,
  admin: 2,
  owner: 3
};
const LEGACY_SITE_COLUMN_MAP = {
  id: 'id',
  license_key: 'license_key',
  site_hash: 'site_hash',
  site_url: 'site_url',
  site_name: 'site_name',
  fingerprint: 'fingerprint',
  site_fingerprint: 'fingerprint',
  wp_install_uuid: 'site_hash',
  status: 'status',
  activated_at: 'activated_at',
  last_activity_at: 'last_activity_at',
  deactivated_at: 'deactivated_at'
};

function maskSecret(value) {
  if (!value) return null;
  const stringValue = String(value);
  return stringValue.length <= 8 ? '[redacted]' : `${stringValue.slice(0, 8)}...`;
}

function ensureDiagnosticsBucket(target, key) {
  if (!target) return null;
  if (!target[key]) {
    target[key] = {
      attempted: false,
      success: null,
      error: null
    };
  }
  return target[key];
}

function finalizeSiteDiagnostics(diagnostics) {
  if (!diagnostics) return null;

  const siteWrites = ['create', 'reconcile']
    .map((key) => diagnostics[key])
    .filter((entry) => entry && entry.attempted);
  const failedSiteWrite = siteWrites.find((entry) => entry.success === false) || null;

  diagnostics.site_write_attempted = siteWrites.length > 0;
  diagnostics.site_write_succeeded = siteWrites.length > 0
    ? !failedSiteWrite
    : null;
  diagnostics.site_write_error = failedSiteWrite?.error || null;

  return diagnostics;
}

function isUniqueViolation(error) {
  return Boolean(error && error.code === '23505');
}

function normalizeTrialCredits(trialCredits = getAnonymousTrialLimit()) {
  const parsed = Number(trialCredits || getAnonymousTrialLimit());
  return Number.isFinite(parsed) ? Math.max(1, Math.floor(parsed)) : getAnonymousTrialLimit();
}

function isMissingSitesV2Schema(error) {
  return isMissingSchemaError(error);
}

function hashRequestFingerprint(payload) {
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

async function maybeSingle(query) {
  const { data, error } = await query.maybeSingle();
  return { data, error };
}

async function fetchAccountByLicenseKey(supabase, licenseKey) {
  if (!supabase || !licenseKey) return null;
  const { data, error } = await maybeSingle(
    supabase.from('licenses').select(ACCOUNT_SELECT).eq('license_key', licenseKey)
  );
  if (error && !isMissingSchemaError(error)) {
    logger.warn('[siteQuota] account lookup by license key failed', {
      licenseKeyPrefix: maskSecret(licenseKey),
      error: error.message
    });
  }
  return data || null;
}

async function fetchAccountById(supabase, accountId) {
  if (!supabase || !accountId) return null;
  const { data, error } = await maybeSingle(
    supabase.from('licenses').select(ACCOUNT_SELECT).eq('id', accountId)
  );
  if (error && !isMissingSchemaError(error)) {
    logger.warn('[siteQuota] account lookup by id failed', { accountId, error: error.message });
  }
  return data || null;
}

function normalizeLegacySiteRecord(site = {}) {
  if (!site) return null;

  const derivedIdentity = buildSiteIdentity({
    siteHash: site.site_hash || null,
    installUuid: site.wp_install_uuid || site.site_hash || null,
    siteUrl: site.site_url || null,
    siteFingerprint: site.site_fingerprint || site.fingerprint || null,
    allowDevelopment: true
  });

  return {
    ...site,
    site_fingerprint: site.site_fingerprint || site.fingerprint || derivedIdentity.siteFingerprint || null,
    wp_install_uuid: site.wp_install_uuid || site.site_hash || derivedIdentity.wpInstallUuid || null,
    normalized_site_url: site.normalized_site_url || derivedIdentity.normalizedSiteUrl || null,
    canonical_domain: site.canonical_domain || derivedIdentity.canonicalDomain || null,
    owner_user_id: site.owner_user_id || null,
    merged_into_site_id: site.merged_into_site_id || null,
    first_seen_at: site.first_seen_at || site.activated_at || site.last_activity_at || site.created_at || null,
    last_seen_at: site.last_seen_at || site.last_activity_at || site.activated_at || site.updated_at || null,
    updated_at: site.updated_at || site.last_activity_at || site.activated_at || site.created_at || null,
    environment: site.environment || (derivedIdentity.isDevelopment ? 'development' : 'production')
  };
}

function logLegacySitesFallback(event, {
  column = null,
  value = null,
  error = null,
  siteHash = null,
  siteUrl = null
} = {}) {
  logger.warn(`[site] ${event}`, {
    match_column: column,
    match_value: truncateMatchValue(value),
    site_hash: siteHash || null,
    site_url: siteUrl || null,
    error: serializeSupabaseError(error)
  });
}

async function queryLegacySitesByColumn(supabase, column, value) {
  if (!supabase || !column || value === null || value === undefined) {
    return { data: [], error: null, matchedBy: null };
  }

  const mappedColumn = LEGACY_SITE_COLUMN_MAP[column];
  if (mappedColumn) {
    const { data, error } = await supabase
      .from('sites')
      .select(LEGACY_SITE_SELECT)
      .eq(mappedColumn, value);

    return {
      data: Array.isArray(data) ? data.map((row) => normalizeLegacySiteRecord(row)) : [],
      error,
      matchedBy: mappedColumn
    };
  }

  if (column === 'normalized_site_url' || column === 'canonical_domain') {
    const { data, error } = await supabase
      .from('sites')
      .select(LEGACY_SITE_SELECT);

    const rows = Array.isArray(data) ? data.map((row) => normalizeLegacySiteRecord(row)) : [];
    const filtered = rows.filter((row) => (
      column === 'normalized_site_url'
        ? row.normalized_site_url === value
        : row.canonical_domain === value
    ));

    return {
      data: filtered,
      error,
      matchedBy: column
    };
  }

  return { data: [], error: null, matchedBy: null };
}

async function fetchSiteByColumn(supabase, column, value) {
  if (!supabase || !column || !value) return { site: null, candidates: [] };
  const { data, error } = await supabase
    .from('sites')
    .select(SITE_SELECT)
    .eq(column, value);

  if (error && isMissingSitesV2Schema(error)) {
    logLegacySitesFallback('canonical_site_lookup_v2_unavailable', {
      column,
      value,
      error
    });

    const legacyResult = await queryLegacySitesByColumn(supabase, column, value);
    if (legacyResult.error && !isMissingSchemaError(legacyResult.error)) {
      logger.warn('[siteQuota] legacy site lookup failed', {
        column,
        value,
        error: legacyResult.error.message
      });
      return { site: null, candidates: [] };
    }

    const legacyCandidates = legacyResult.data || [];
    if (!legacyCandidates.length) {
      return { site: null, candidates: [] };
    }

    return {
      site: choosePreferredSiteCandidate(legacyCandidates) || null,
      candidates: legacyCandidates
    };
  }

  if (error && !isMissingSchemaError(error)) {
    logger.warn('[siteQuota] site lookup failed', {
      column,
      value,
      error: error.message
    });
    return { site: null, candidates: [] };
  }

  const candidates = data || [];
  if (!candidates.length) {
    return { site: null, candidates: [] };
  }

  const preferred = choosePreferredSiteCandidate(candidates);
  return {
    site: preferred || null,
    candidates
  };
}

async function fetchSitesByColumn(supabase, column, value) {
  if (!supabase || !column || !value) return [];
  const { data, error } = await supabase
    .from('sites')
    .select(SITE_SELECT)
    .eq(column, value);

  if (error && isMissingSitesV2Schema(error)) {
    logLegacySitesFallback('canonical_site_candidate_lookup_v2_unavailable', {
      column,
      value,
      error
    });

    const legacyResult = await queryLegacySitesByColumn(supabase, column, value);
    if (legacyResult.error && !isMissingSchemaError(legacyResult.error)) {
      logger.warn('[siteQuota] legacy site candidate lookup failed', {
        column,
        value,
        error: legacyResult.error.message
      });
      return [];
    }

    return legacyResult.data || [];
  }

  if (error && !isMissingSchemaError(error)) {
    logger.warn('[siteQuota] site candidate lookup failed', { column, value, error: error.message });
    return [];
  }

  return data || [];
}

function siteStatusPriority(site) {
  if (!site) return 0;
  if (site.status === 'active' && !site.merged_into_site_id) return 4;
  if (site.status === 'active') return 3;
  if (site.status === 'suspended') return 2;
  if (site.status === 'deactivated') return 1;
  return 0;
}

function siteTimestamp(site) {
  const value = site?.last_seen_at
    || site?.updated_at
    || site?.first_seen_at
    || site?.activated_at
    || null;
  const timestamp = value ? Date.parse(value) : 0;
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function choosePreferredSiteCandidate(candidates = []) {
  return [...candidates].sort((left, right) => {
    const statusDelta = siteStatusPriority(right) - siteStatusPriority(left);
    if (statusDelta !== 0) return statusDelta;

    const mergeDelta = Number(Boolean(left?.merged_into_site_id)) - Number(Boolean(right?.merged_into_site_id));
    if (mergeDelta !== 0) return mergeDelta;

    const licenseDelta = Number(Boolean(right?.license_key)) - Number(Boolean(left?.license_key));
    if (licenseDelta !== 0) return licenseDelta;

    const ownerDelta = Number(Boolean(right?.owner_user_id)) - Number(Boolean(left?.owner_user_id));
    if (ownerDelta !== 0) return ownerDelta;

    return siteTimestamp(right) - siteTimestamp(left);
  })[0] || null;
}

function truncateMatchValue(value) {
  if (value === null || value === undefined) return null;
  const normalized = String(value);
  return normalized.length > 255 ? `${normalized.slice(0, 255)}...` : normalized;
}

function maskLicenseKeyForCreditAudit(licenseKey) {
  if (!licenseKey) return null;
  const normalized = String(licenseKey);
  return normalized.length > 8 ? `${normalized.substring(0, 8)}...` : normalized;
}

function toCreditAuditIsoString(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}

function toCreditAuditNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function logCreditsAudit(message, details = {}, level = 'info') {
  logger[level](`[bbai-credits] ${message}`, details);
}

async function selectEffectiveSiteQuotaRead(supabase, {
  site = null,
  siteQuota = null,
  account = null,
  licenseKey = null,
  quotaPeriodStart = null,
  quotaPeriodEnd = null,
  totalLimit = 0,
  requestId = null
} = {}) {
  const auditContext = {
    request_id: requestId || null,
    account_id: account?.id || null,
    license_key_prefix: maskLicenseKeyForCreditAudit(licenseKey || account?.license_key || site?.license_key || null),
    site_id: site?.id || null,
    site_hash: site?.site_hash || null,
    period_start: toCreditAuditIsoString(quotaPeriodStart),
    period_end: toCreditAuditIsoString(quotaPeriodEnd)
  };
  const currentUsed = toCreditAuditNumber(siteQuota?.used_credits, 0);
  const currentRemaining = siteQuota?.remaining_credits ?? Math.max(toCreditAuditNumber(totalLimit, 0) - currentUsed, 0);

  logCreditsAudit('period_selected', {
    ...auditContext,
    source_path: 'site_quota_v2'
  });

  logCreditsAudit('rows_found', {
    ...auditContext,
    source_candidate: 'site_quotas',
    lookup_key: 'site_id+quota_period_start+quota_period_end',
    rows_found: siteQuota ? 1 : 0,
    credits_used_candidate: currentUsed,
    credits_remaining_candidate: toCreditAuditNumber(currentRemaining, 0)
  });

  let summaryRow = null;
  let summaryCandidate = 0;
  if (auditContext.license_key_prefix && auditContext.period_start) {
    const { data, error } = await supabase
      .from('quota_summaries')
      .select('period_start, period_end, total_credits_used, site_usage')
      .eq('license_key', licenseKey)
      .eq('period_start', auditContext.period_start)
      .maybeSingle();

    summaryRow = data || null;
    summaryCandidate = data
      ? (
          site?.site_hash
            ? toCreditAuditNumber(data?.site_usage?.[site.site_hash], 0)
            : toCreditAuditNumber(data?.total_credits_used, 0)
        )
      : 0;

    logCreditsAudit('rows_found', {
      ...auditContext,
      source_candidate: 'quota_summaries',
      lookup_key: 'license_key+period_start',
      rows_found: data ? 1 : 0,
      credits_used_candidate: summaryCandidate,
      error: error ? serializeSupabaseError(error) : null
    }, error ? 'warn' : 'info');
  } else {
    logCreditsAudit('rows_found', {
      ...auditContext,
      source_candidate: 'quota_summaries',
      lookup_key: 'license_key+period_start',
      rows_found: 0,
      credits_used_candidate: 0,
      fallback_reason: licenseKey ? 'missing_period_start' : 'missing_license_key'
    });
  }

  let usageRows = 0;
  let usageCandidate = 0;
  let usageSourceKey = 'site_hash';
  if (auditContext.period_start && auditContext.period_end && (site?.site_hash || licenseKey)) {
    let usageQuery = supabase
      .from('usage_logs')
      .select('credits_used, created_at, license_key, site_hash')
      .gte('created_at', auditContext.period_start)
      .lt('created_at', auditContext.period_end);

    if (site?.site_hash) {
      usageQuery = usageQuery.eq('site_hash', site.site_hash);
      usageSourceKey = 'site_hash';
    } else {
      usageQuery = usageQuery.eq('license_key', licenseKey);
      usageSourceKey = 'license_key';
    }

    const { data, error } = await usageQuery;
    usageRows = Array.isArray(data) ? data.length : 0;
    usageCandidate = Array.isArray(data)
      ? data.reduce((sum, row) => sum + toCreditAuditNumber(row?.credits_used, 1), 0)
      : 0;

    logCreditsAudit('rows_found', {
      ...auditContext,
      source_candidate: 'usage_logs',
      lookup_key: usageSourceKey,
      rows_found: usageRows,
      credits_used_candidate: usageCandidate,
      error: error ? serializeSupabaseError(error) : null
    }, error ? 'warn' : 'info');
  } else {
    logCreditsAudit('rows_found', {
      ...auditContext,
      source_candidate: 'usage_logs',
      lookup_key: site?.site_hash ? 'site_hash' : 'license_key',
      rows_found: 0,
      credits_used_candidate: 0,
      fallback_reason: auditContext.period_start && auditContext.period_end
        ? 'missing_site_hash_and_license_key'
        : 'missing_period_bounds'
    });
  }

  let selectedSource = 'site_quotas';
  let selectedUsed = currentUsed;
  let fallbackReason = null;
  let selectedRowsFound = siteQuota ? 1 : 0;

  if (usageCandidate > selectedUsed) {
    selectedSource = 'usage_logs';
    selectedUsed = usageCandidate;
    selectedRowsFound = usageRows;
    fallbackReason = 'legacy_usage_exceeds_site_quota';
  } else if (summaryCandidate > selectedUsed) {
    selectedSource = 'quota_summaries';
    selectedUsed = summaryCandidate;
    selectedRowsFound = summaryRow ? 1 : 0;
    fallbackReason = 'legacy_summary_exceeds_site_quota';
  } else if (!siteQuota) {
    selectedSource = usageRows > 0 ? 'usage_logs' : (summaryRow ? 'quota_summaries' : 'fallback/default path');
    selectedUsed = Math.max(usageCandidate, summaryCandidate, 0);
    selectedRowsFound = selectedSource === 'usage_logs'
      ? usageRows
      : (summaryRow ? 1 : 0);
    fallbackReason = usageRows > 0
      ? 'site_quota_missing'
      : (summaryRow ? 'site_quota_missing' : 'site_quota_missing_and_legacy_empty');
  } else if (currentUsed === 0 && usageRows === 0 && summaryCandidate === 0) {
    fallbackReason = 'no_nonzero_usage_rows_found';
  }

  const selectedRemaining = Math.max(toCreditAuditNumber(totalLimit, 0) - selectedUsed, 0);

  logCreditsAudit('source_selected', {
    ...auditContext,
    source_selected: selectedSource,
    rows_found: selectedRowsFound,
    used: selectedUsed,
    limit: toCreditAuditNumber(totalLimit, 0),
    remaining: selectedRemaining,
    fallback_reason: fallbackReason
  });

  return {
    used: selectedUsed,
    remaining: selectedRemaining
  };
}

function logCanonicalSiteResolutionAttempt({
  identity,
  createIfMissing,
  account,
  requestId
} = {}) {
  logger.info('[site] canonical_site_resolution_attempted', {
    request_id: requestId || null,
    account_id: account?.id || null,
    create_if_missing: Boolean(createIfMissing),
    site_hash: identity?.siteHash || identity?.syntheticSiteHash || null,
    install_uuid: identity?.wpInstallUuid || null,
    site_url: identity?.siteUrl || identity?.normalizedSiteUrl || null,
    canonical_domain: identity?.canonicalDomain || null,
    site_fingerprint_present: Boolean(identity?.siteFingerprint)
  });
}

function logCanonicalSiteResolutionFailed({
  identity,
  createIfMissing,
  account,
  requestId,
  errorCode,
  matchedBy = null
} = {}) {
  const level = errorCode === 'INVALID_SITE_IDENTITY' || errorCode === 'DEVELOPMENT_SITE_NOT_ALLOWED'
    ? 'warn'
    : 'error';
  logger[level]('[site] canonical_site_resolution_failed', {
    request_id: requestId || null,
    account_id: account?.id || null,
    create_if_missing: Boolean(createIfMissing),
    error: errorCode || 'UNKNOWN_SITE_RESOLUTION_ERROR',
    matched_by: matchedBy || null,
    site_hash: identity?.siteHash || identity?.syntheticSiteHash || null,
    install_uuid: identity?.wpInstallUuid || null,
    site_url: identity?.siteUrl || identity?.normalizedSiteUrl || null,
    canonical_domain: identity?.canonicalDomain || null,
    site_fingerprint_present: Boolean(identity?.siteFingerprint)
  });
}

async function findSiteMatch(supabase, column, value, {
  account = null,
  requestId = null
} = {}) {
  if (!value) {
    return { site: null, candidates: [] };
  }

  const { site, candidates } = await fetchSiteByColumn(supabase, column, value);
  if (!site) {
    return { site: null, candidates: [] };
  }

  if (candidates.length > 1) {
    logger.warn('[siteQuota] Duplicate site identity candidates detected', {
      match_column: column,
      match_value: truncateMatchValue(value),
      candidate_site_ids: candidates.map((candidate) => candidate.id),
      chosen_site_id: site.id,
      duplicate_count: candidates.length
    });

    await recordSiteAudit(supabase, {
      siteId: site.id,
      actorUserId: account?.id || null,
      eventType: 'duplicate_site_identity_detected',
      severity: 'warn',
      requestId,
      metadata: {
        match_column: column,
        match_value: truncateMatchValue(value),
        candidate_site_ids: candidates.map((candidate) => candidate.id),
        chosen_site_id: site.id
      }
    });
  }

  return { site, candidates };
}

async function followMergedSite(supabase, site) {
  if (!site?.merged_into_site_id) return site;
  const { site: mergedTarget } = await fetchSiteByColumn(supabase, 'id', site.merged_into_site_id);
  return mergedTarget || site;
}

async function reconcileResolvedSite(supabase, site, identity, { legacyLicenseKey = null, account = null, diagnostics = null } = {}) {
  if (!supabase || !site?.id) return site;
  const reconcileDiagnostics = ensureDiagnosticsBucket(diagnostics, 'reconcile');

  const updates = {
    last_seen_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };

  if (!site.site_fingerprint && identity.siteFingerprint) {
    updates.site_fingerprint = identity.siteFingerprint;
    updates.fingerprint = identity.siteFingerprint;
  }
  if (!site.wp_install_uuid && identity.wpInstallUuid) {
    updates.wp_install_uuid = identity.wpInstallUuid;
  }
  if (!site.normalized_site_url && identity.normalizedSiteUrl) {
    updates.normalized_site_url = identity.normalizedSiteUrl;
  }
  if (!site.canonical_domain && identity.canonicalDomain) {
    updates.canonical_domain = identity.canonicalDomain;
  }
  if ((!site.site_url || site.site_url === 'unknown') && identity.siteUrl) {
    updates.site_url = identity.siteUrl;
  }
  if (!site.owner_user_id && account?.id) {
    updates.owner_user_id = account.id;
  }
  if (!site.license_key && (legacyLicenseKey || account?.license_key)) {
    updates.license_key = legacyLicenseKey || account.license_key;
  }

  if (Object.keys(updates).length <= 2) {
    if (reconcileDiagnostics) {
      reconcileDiagnostics.attempted = false;
      reconcileDiagnostics.success = null;
      reconcileDiagnostics.error = null;
      reconcileDiagnostics.updated_fields = [];
    }
    return site;
  }

  const { data, error } = await supabase
    .from('sites')
    .update(updates)
    .eq('id', site.id)
    .select(SITE_SELECT)
    .single();

  if (error && isMissingSitesV2Schema(error)) {
    logLegacySitesFallback('canonical_site_reconcile_v2_unavailable', {
      column: 'id',
      value: site.id,
      error,
      siteHash: site.site_hash || identity.siteHash || null,
      siteUrl: site.site_url || identity.siteUrl || null
    });

    const legacyUpdates = {
      last_activity_at: updates.last_seen_at || new Date().toISOString()
    };
    if ((!site.fingerprint || site.fingerprint === 'unknown') && identity.siteFingerprint) {
      legacyUpdates.fingerprint = identity.siteFingerprint;
    }
    if ((!site.site_url || site.site_url === 'unknown') && identity.siteUrl) {
      legacyUpdates.site_url = identity.siteUrl;
    }
    if (!site.license_key && (legacyLicenseKey || account?.license_key)) {
      legacyUpdates.license_key = legacyLicenseKey || account.license_key;
    }
    if (site.status !== 'active') {
      legacyUpdates.status = 'active';
    }

    const { data: legacyData, error: legacyError } = await supabase
      .from('sites')
      .update(legacyUpdates)
      .eq('id', site.id)
      .select(LEGACY_SITE_SELECT)
      .single();

    if (legacyError) {
      if (reconcileDiagnostics) {
        reconcileDiagnostics.attempted = true;
        reconcileDiagnostics.success = false;
        reconcileDiagnostics.error = serializeSupabaseError(legacyError);
        reconcileDiagnostics.updated_fields = Object.keys(legacyUpdates);
        reconcileDiagnostics.schema_mode = 'legacy';
      }
      logger.error('[site] canonical_site_reconcile_failed', {
        site_id: site.id,
        site_hash: site.site_hash || identity.siteHash || null,
        schema_mode: 'legacy',
        error: serializeSupabaseError(legacyError)
      });
      logger.warn('[siteQuota] legacy resolved site reconcile failed', {
        siteId: site.id,
        error: legacyError.message
      });
      return normalizeLegacySiteRecord(site);
    }

    if (reconcileDiagnostics) {
      reconcileDiagnostics.attempted = true;
      reconcileDiagnostics.success = true;
      reconcileDiagnostics.error = null;
      reconcileDiagnostics.updated_fields = Object.keys(legacyUpdates);
      reconcileDiagnostics.schema_mode = 'legacy';
    }
    logger.info('[site] canonical_site_reconciled', {
      site_id: legacyData?.id || site.id,
      site_hash: legacyData?.site_hash || site.site_hash || identity.siteHash || null,
      updated_fields: Object.keys(legacyUpdates),
      schema_mode: 'legacy'
    });

    return normalizeLegacySiteRecord(legacyData || {
      ...site,
      ...legacyUpdates
    });
  }

  if (error) {
    if (reconcileDiagnostics) {
      reconcileDiagnostics.attempted = true;
      reconcileDiagnostics.success = false;
      reconcileDiagnostics.error = serializeSupabaseError(error);
      reconcileDiagnostics.updated_fields = Object.keys(updates);
    }
    logger.error('[site] canonical_site_reconcile_failed', {
      site_id: site.id,
      site_hash: site.site_hash || identity.siteHash || null,
      error: serializeSupabaseError(error)
    });
    logger.warn('[siteQuota] failed to reconcile resolved site', {
      siteId: site.id,
      error: error.message
    });
    return {
      ...site,
      ...updates
    };
  }

  if (reconcileDiagnostics) {
    reconcileDiagnostics.attempted = true;
    reconcileDiagnostics.success = true;
    reconcileDiagnostics.error = null;
    reconcileDiagnostics.updated_fields = Object.keys(updates);
  }
  logger.info('[site] canonical_site_reconciled', {
    site_id: data?.id || site.id,
    site_hash: data?.site_hash || site.site_hash || identity.siteHash || null,
    updated_fields: Object.keys(updates)
  });

  return data || {
    ...site,
    ...updates
  };
}

async function createCanonicalSite(supabase, identity, { legacyLicenseKey = null, account = null, diagnostics = null } = {}) {
  const now = new Date().toISOString();
  const createDiagnostics = ensureDiagnosticsBucket(diagnostics, 'create');
  const payload = {
    site_hash: identity.siteHash || identity.syntheticSiteHash,
    wp_install_uuid: identity.wpInstallUuid || identity.siteHash || identity.syntheticSiteHash,
    site_url: identity.siteUrl || identity.normalizedSiteUrl || null,
    normalized_site_url: identity.normalizedSiteUrl,
    canonical_domain: identity.canonicalDomain,
    site_fingerprint: identity.siteFingerprint,
    fingerprint: identity.siteFingerprint,
    status: 'active',
    owner_user_id: account?.id || null,
    license_key: legacyLicenseKey || account?.license_key || null,
    first_seen_at: now,
    last_seen_at: now,
    updated_at: now,
    activated_at: now,
    last_activity_at: now,
    environment: identity.isDevelopment ? 'development' : 'production'
  };

  const { data, error } = await supabase
    .from('sites')
    .insert(payload)
    .select(SITE_SELECT)
    .single();

  if (error && isMissingSitesV2Schema(error)) {
    logLegacySitesFallback('canonical_site_create_v2_unavailable', {
      error,
      siteHash: payload.site_hash,
      siteUrl: payload.site_url || null
    });

    const legacyPayload = {
      license_key: legacyLicenseKey || account?.license_key || null,
      site_hash: payload.site_hash,
      site_url: payload.site_url || 'unknown',
      fingerprint: payload.site_fingerprint || null,
      status: 'active',
      activated_at: now,
      last_activity_at: now
    };

    const { data: legacyData, error: legacyError } = await supabase
      .from('sites')
      .insert(legacyPayload)
      .select(LEGACY_SITE_SELECT)
      .single();

    if (legacyError && isUniqueViolation(legacyError)) {
      if (createDiagnostics) {
        createDiagnostics.attempted = true;
        createDiagnostics.success = false;
        createDiagnostics.error = {
          code: 'UNIQUE_REUSED_EXISTING',
          message: 'Unique race reused existing legacy row'
        };
        createDiagnostics.reused_existing = true;
        createDiagnostics.schema_mode = 'legacy';
      }
      logger.info('[siteQuota] Legacy site create reused existing row after unique race', {
        site_hash: legacyPayload.site_hash,
        site_url: legacyPayload.site_url || null
      });
      return null;
    }

    if (legacyError) {
      if (createDiagnostics) {
        createDiagnostics.attempted = true;
        createDiagnostics.success = false;
        createDiagnostics.error = serializeSupabaseError(legacyError);
        createDiagnostics.reused_existing = false;
        createDiagnostics.schema_mode = 'legacy';
      }
      logger.error('[site] canonical_site_create_failed', {
        site_hash: legacyPayload.site_hash,
        site_url: legacyPayload.site_url || null,
        canonical_domain: payload.canonical_domain || null,
        schema_mode: 'legacy',
        error: serializeSupabaseError(legacyError)
      });
      logger.error('[siteQuota] Legacy site creation failed', {
        site_hash: legacyPayload.site_hash,
        site_url: legacyPayload.site_url || null,
        error: serializeSupabaseError(legacyError)
      });
      throw legacyError;
    }

    if (createDiagnostics) {
      createDiagnostics.attempted = true;
      createDiagnostics.success = true;
      createDiagnostics.error = null;
      createDiagnostics.reused_existing = false;
      createDiagnostics.schema_mode = 'legacy';
    }

    logger.info('[site] canonical_site_created', {
      site_id: legacyData?.id || null,
      site_hash: legacyPayload.site_hash,
      site_url: legacyPayload.site_url || null,
      canonical_domain: payload.canonical_domain || null,
      schema_mode: 'legacy'
    });

    logger.info('[siteQuota] Legacy site created', {
      site_id: legacyData?.id || null,
      site_hash: legacyPayload.site_hash,
      site_url: legacyPayload.site_url || null,
      has_license: !!legacyPayload.license_key
    });

    return normalizeLegacySiteRecord(legacyData || legacyPayload);
  }

  if (error && isUniqueViolation(error)) {
    if (createDiagnostics) {
      createDiagnostics.attempted = true;
      createDiagnostics.success = false;
      createDiagnostics.error = {
        code: 'UNIQUE_REUSED_EXISTING',
        message: 'Unique race reused existing row'
      };
      createDiagnostics.reused_existing = true;
    }
    logger.info('[siteQuota] Site create reused existing row after unique race', {
      site_hash: payload.site_hash,
      site_url: payload.site_url || null,
      canonical_domain: payload.canonical_domain || null
    });
    return null;
  }

  if (error) {
    if (createDiagnostics) {
      createDiagnostics.attempted = true;
      createDiagnostics.success = false;
      createDiagnostics.error = serializeSupabaseError(error);
      createDiagnostics.reused_existing = false;
    }
    logger.error('[site] canonical_site_create_failed', {
      site_hash: payload.site_hash,
      site_url: payload.site_url || null,
      canonical_domain: payload.canonical_domain || null,
      error: serializeSupabaseError(error)
    });
    logger.error('[siteQuota] Site creation failed', {
      site_hash: payload.site_hash,
      site_url: payload.site_url || null,
      canonical_domain: payload.canonical_domain || null,
      error: serializeSupabaseError(error)
    });
    throw error;
  }

  if (createDiagnostics) {
    createDiagnostics.attempted = true;
    createDiagnostics.success = true;
    createDiagnostics.error = null;
    createDiagnostics.reused_existing = false;
  }

  logger.info('[site] canonical_site_created', {
    site_id: data?.id || null,
    site_hash: payload.site_hash,
    site_url: payload.site_url || null,
    canonical_domain: payload.canonical_domain || null
  });

  logger.info('[siteQuota] Site created', {
    site_id: data?.id || null,
    site_hash: payload.site_hash,
    site_url: payload.site_url || null,
    canonical_domain: payload.canonical_domain || null,
    environment: payload.environment,
    has_license: !!payload.license_key,
    has_owner: !!payload.owner_user_id
  });

  return data || payload;
}

async function recordSiteAudit(supabase, {
  siteId = null,
  actorUserId = null,
  eventType,
  severity = 'info',
  requestId = null,
  metadata = {}
} = {}) {
  if (!supabase || !eventType) return;

  const { error } = await supabase
    .from('site_audit_logs')
    .insert({
      site_id: siteId,
      actor_user_id: actorUserId,
      event_type: eventType,
      severity,
      request_id: requestId,
      metadata
    });

  if (error && !isMissingSchemaError(error)) {
    logger.warn('[siteQuota] failed to write site audit log', {
      eventType,
      siteId,
      actorUserId,
      error: error.message
    });
  }
}

async function ensureSiteMembership(supabase, {
  siteId,
  userId,
  role = 'member',
  invitedByUserId = null,
  diagnostics = null
} = {}) {
  if (!supabase || !siteId || !userId) return null;
  const membershipDiagnostics = ensureDiagnosticsBucket(diagnostics, 'membership');
  if (membershipDiagnostics) {
    membershipDiagnostics.attempted = true;
    membershipDiagnostics.site_id = siteId;
    membershipDiagnostics.user_id = userId;
    membershipDiagnostics.role = role;
  }

  const { data: existing, error: existingError } = await maybeSingle(
    supabase.from('site_memberships').select('id, role, site_id, user_id').eq('site_id', siteId).eq('user_id', userId)
  );

  if (existingError && isMissingSchemaError(existingError)) {
    if (membershipDiagnostics) {
      membershipDiagnostics.success = false;
      membershipDiagnostics.error = serializeSupabaseError(existingError);
      membershipDiagnostics.stage = 'lookup';
      membershipDiagnostics.skipped = 'site_memberships_unavailable';
    }
    logger.warn('[site] site_membership_schema_unavailable', {
      site_id: siteId,
      user_id: userId,
      role,
      error: serializeSupabaseError(existingError)
    });
    return null;
  }

  if (existingError && !isMissingSchemaError(existingError)) {
    if (membershipDiagnostics) {
      membershipDiagnostics.success = false;
      membershipDiagnostics.error = serializeSupabaseError(existingError);
      membershipDiagnostics.stage = 'lookup';
    }
    logger.error('[site] site_membership_lookup_failed', {
      site_id: siteId,
      user_id: userId,
      error: serializeSupabaseError(existingError)
    });
    logger.warn('[siteQuota] membership lookup failed', {
      siteId,
      userId,
      error: existingError.message
    });
  }

  if (existing) {
    if ((ROLE_RANK[role] || 0) <= (ROLE_RANK[existing.role] || 0)) {
      if (membershipDiagnostics) {
        membershipDiagnostics.success = true;
        membershipDiagnostics.error = null;
        membershipDiagnostics.action = 'existing';
      }
      logger.info('[site] site_membership_reused', {
        site_id: siteId,
        user_id: userId,
        role: existing.role
      });
      return existing;
    }

    const { data, error } = await supabase
      .from('site_memberships')
      .update({
        role,
        updated_at: new Date().toISOString()
      })
      .eq('id', existing.id)
      .select('id, role, site_id, user_id')
      .single();

    if (error && isMissingSchemaError(error)) {
      if (membershipDiagnostics) {
        membershipDiagnostics.success = false;
        membershipDiagnostics.error = serializeSupabaseError(error);
        membershipDiagnostics.stage = 'update';
        membershipDiagnostics.action = 'update';
        membershipDiagnostics.skipped = 'site_memberships_unavailable';
      }
      logger.warn('[site] site_membership_schema_unavailable', {
        site_id: siteId,
        user_id: userId,
        role,
        action: 'update',
        error: serializeSupabaseError(error)
      });
      return existing;
    }

    if (error && !isMissingSchemaError(error)) {
      if (membershipDiagnostics) {
        membershipDiagnostics.success = false;
        membershipDiagnostics.error = serializeSupabaseError(error);
        membershipDiagnostics.stage = 'update';
        membershipDiagnostics.action = 'update';
      }
      logger.error('[site] site_membership_upsert_failed', {
        site_id: siteId,
        user_id: userId,
        role,
        error: serializeSupabaseError(error)
      });
      logger.warn('[siteQuota] membership escalation failed', {
        siteId,
        userId,
        role,
        error: error.message
      });
    }

    if (!error && membershipDiagnostics) {
      membershipDiagnostics.success = true;
      membershipDiagnostics.error = null;
      membershipDiagnostics.action = 'update';
    }
    if (!error) {
      logger.info('[site] site_membership_upsert_succeeded', {
        site_id: siteId,
        user_id: userId,
        role,
        action: 'update'
      });
    }

    return data || existing;
  }

  const { data, error } = await supabase
    .from('site_memberships')
    .insert({
      site_id: siteId,
      user_id: userId,
      role,
      invited_by_user_id: invitedByUserId
    })
    .select('id, role, site_id, user_id')
    .single();

  if (error && isMissingSchemaError(error)) {
    if (membershipDiagnostics) {
      membershipDiagnostics.success = false;
      membershipDiagnostics.error = serializeSupabaseError(error);
      membershipDiagnostics.stage = 'insert';
      membershipDiagnostics.action = 'insert';
      membershipDiagnostics.skipped = 'site_memberships_unavailable';
    }
    logger.warn('[site] site_membership_schema_unavailable', {
      site_id: siteId,
      user_id: userId,
      role,
      action: 'insert',
      error: serializeSupabaseError(error)
    });
    return null;
  }

  if (error && !isMissingSchemaError(error)) {
    if (membershipDiagnostics) {
      membershipDiagnostics.success = false;
      membershipDiagnostics.error = serializeSupabaseError(error);
      membershipDiagnostics.stage = 'insert';
      membershipDiagnostics.action = 'insert';
    }
    logger.error('[site] site_membership_upsert_failed', {
      site_id: siteId,
      user_id: userId,
      role,
      error: serializeSupabaseError(error)
    });
    logger.warn('[siteQuota] membership create failed', {
      siteId,
      userId,
      role,
      error: error.message
    });
    return null;
  }

  if (membershipDiagnostics) {
    membershipDiagnostics.success = true;
    membershipDiagnostics.error = null;
    membershipDiagnostics.action = 'insert';
  }
  logger.info('[site] site_membership_upsert_succeeded', {
    site_id: siteId,
    user_id: userId,
    role,
    action: 'insert'
  });

  return data || null;
}

async function resolveCanonicalSite(supabase, rawIdentity, {
  createIfMissing = false,
  legacyLicenseKey = null,
  account = null,
  requestId = null
} = {}) {
  const identity = rawIdentity?.normalizedSiteUrl !== undefined
    ? rawIdentity
    : buildSiteIdentity(rawIdentity);

  logCanonicalSiteResolutionAttempt({
    identity,
    createIfMissing,
    account,
    requestId
  });

  if (!identity.isValid) {
    logCanonicalSiteResolutionFailed({
      identity,
      createIfMissing,
      account,
      requestId,
      errorCode: identity.error || 'INVALID_SITE_IDENTITY'
    });
    return {
      site: null,
      identity,
      matchedBy: null,
      created: false,
      error: identity.error || 'INVALID_SITE_IDENTITY',
      diagnostics: finalizeSiteDiagnostics({
        identity_error: identity.error || 'INVALID_SITE_IDENTITY'
      })
    };
  }

  if (identity.error === 'DEVELOPMENT_SITE_NOT_ALLOWED') {
    logCanonicalSiteResolutionFailed({
      identity,
      createIfMissing,
      account,
      requestId,
      errorCode: identity.error
    });
    return {
      site: null,
      identity,
      matchedBy: null,
      created: false,
      error: identity.error,
      diagnostics: finalizeSiteDiagnostics({
        identity_error: identity.error
      })
    };
  }

  const diagnostics = {
    create: { attempted: false, success: null, error: null },
    reconcile: { attempted: false, success: null, error: null },
    membership: { attempted: false, success: null, error: null }
  };

  let matchedBy = null;
  let site = null;

  if (identity.wpInstallUuid) {
    const match = await findSiteMatch(supabase, 'wp_install_uuid', identity.wpInstallUuid, {
      account,
      requestId
    });
    site = match.site;
    matchedBy = site ? 'wp_install_uuid' : matchedBy;
  }

  if (!site && identity.siteHash) {
    const match = await findSiteMatch(supabase, 'site_hash', identity.siteHash, {
      account,
      requestId
    });
    site = match.site;
    matchedBy = site ? 'site_hash' : matchedBy;
  }

  if (!site && identity.siteFingerprint) {
    const match = await findSiteMatch(supabase, 'site_fingerprint', identity.siteFingerprint, {
      account,
      requestId
    });
    site = match.site;
    matchedBy = site ? 'site_fingerprint' : matchedBy;
  }

  if (!site && identity.siteFingerprint) {
    const match = await findSiteMatch(supabase, 'fingerprint', identity.siteFingerprint, {
      account,
      requestId
    });
    site = match.site;
    matchedBy = site ? 'legacy_fingerprint' : matchedBy;
  }

  if (!site && !identity.isDevelopment && identity.normalizedSiteUrl) {
    const match = await findSiteMatch(supabase, 'normalized_site_url', identity.normalizedSiteUrl, {
      account,
      requestId
    });
    site = match.site;
    matchedBy = site ? 'normalized_site_url' : matchedBy;
  }

  if (!site && !identity.isDevelopment && identity.canonicalDomain) {
    const candidates = await fetchSitesByColumn(supabase, 'canonical_domain', identity.canonicalDomain);
    if (candidates.length === 1) {
      site = candidates[0];
      matchedBy = 'canonical_domain';
    } else if (candidates.length > 1) {
      await recordSiteAudit(supabase, {
        siteId: null,
        actorUserId: account?.id || null,
        eventType: 'ambiguous_site_match',
        severity: 'warn',
        requestId,
        metadata: {
          canonical_domain: identity.canonicalDomain,
          candidate_site_ids: candidates.map((candidate) => candidate.id)
        }
      });

      logCanonicalSiteResolutionFailed({
        identity,
        createIfMissing,
        account,
        requestId,
        errorCode: 'AMBIGUOUS_SITE_MATCH'
      });
      return {
        site: null,
        identity,
        matchedBy: null,
        created: false,
        error: 'AMBIGUOUS_SITE_MATCH',
        candidates,
        diagnostics: finalizeSiteDiagnostics(diagnostics)
      };
    }
  }

  if (site) {
    logger.info('[siteQuota] Existing site reused', {
      site_id: site.id,
      site_hash: site.site_hash,
      site_url: site.site_url || identity.siteUrl || null,
      matched_by: matchedBy,
      canonical_domain: site.canonical_domain || null
    });
    const resolvedSite = await followMergedSite(supabase, site);
    const reconciledSite = await reconcileResolvedSite(supabase, resolvedSite, identity, {
      legacyLicenseKey,
      account,
      diagnostics
    });

    if (account?.id) {
      await ensureSiteMembership(supabase, {
        siteId: reconciledSite.id,
        userId: account.id,
        role: reconciledSite.owner_user_id === account.id ? 'owner' : 'member',
        invitedByUserId: account.id,
        diagnostics
      });
    }

    return {
      site: reconciledSite,
      identity,
      matchedBy,
      created: false,
      error: null,
      diagnostics: finalizeSiteDiagnostics(diagnostics)
    };
  }

  if (!createIfMissing) {
    logCanonicalSiteResolutionFailed({
      identity,
      createIfMissing,
      account,
      requestId,
      errorCode: 'SITE_NOT_FOUND'
    });
    return {
      site: null,
      identity,
      matchedBy: null,
      created: false,
      error: 'SITE_NOT_FOUND',
      diagnostics: finalizeSiteDiagnostics(diagnostics)
    };
  }

  try {
    if (identity.siteHash) {
      const preInsertMatch = await findSiteMatch(supabase, 'site_hash', identity.siteHash, {
        account,
        requestId
      });
      if (preInsertMatch.site) {
        const preInsertResolvedSite = await followMergedSite(supabase, preInsertMatch.site);
        const preInsertReconciledSite = await reconcileResolvedSite(supabase, preInsertResolvedSite, identity, {
          legacyLicenseKey,
          account,
          diagnostics
        });

        if (account?.id && preInsertReconciledSite?.id) {
          await ensureSiteMembership(supabase, {
            siteId: preInsertReconciledSite.id,
            userId: account.id,
            role: preInsertReconciledSite.owner_user_id === account.id ? 'owner' : 'member',
            invitedByUserId: account.id,
            diagnostics
          });
        }

        logger.info('[siteQuota] Site creation short-circuited to existing site', {
          site_id: preInsertReconciledSite?.id || preInsertMatch.site.id,
          site_hash: preInsertReconciledSite?.site_hash || preInsertMatch.site.site_hash,
          site_url: preInsertReconciledSite?.site_url || preInsertMatch.site.site_url || identity.siteUrl || null
        });
        return {
          site: preInsertReconciledSite || preInsertMatch.site,
          identity,
          matchedBy: 'site_hash_preinsert',
          created: false,
          error: null,
          diagnostics: finalizeSiteDiagnostics(diagnostics)
        };
      }
    }

    let createdSite = await createCanonicalSite(supabase, identity, { legacyLicenseKey, account, diagnostics });

    if (!createdSite) {
      createdSite = await resolveCanonicalSite(supabase, identity, {
        createIfMissing: false,
        legacyLicenseKey,
        account,
        requestId
      }).then((result) => {
        diagnostics.reconcile = result?.diagnostics?.reconcile || diagnostics.reconcile;
        diagnostics.membership = result?.diagnostics?.membership || diagnostics.membership;
        diagnostics.create = result?.diagnostics?.create || diagnostics.create;
        return result.site;
      });
    }

    if (createdSite && account?.id) {
      await ensureSiteMembership(supabase, {
        siteId: createdSite.id,
        userId: account.id,
        role: 'owner',
        invitedByUserId: account.id,
        diagnostics
      });
    }

    if (!createdSite) {
      logCanonicalSiteResolutionFailed({
        identity,
        createIfMissing,
        account,
        requestId,
        errorCode: 'SITE_CREATE_FAILED'
      });
    }

    return {
      site: createdSite,
      identity,
      matchedBy: createdSite ? 'created' : null,
      created: Boolean(createdSite),
      error: createdSite ? null : 'SITE_CREATE_FAILED',
      diagnostics: finalizeSiteDiagnostics(diagnostics)
    };
  } catch (error) {
    logger.error('[siteQuota] canonical site create failed', {
      site_hash: identity.siteHash || identity.syntheticSiteHash || null,
      site_url: identity.siteUrl || identity.normalizedSiteUrl || null,
      error: serializeSupabaseError(error)
    });
    diagnostics.create = {
      attempted: true,
      success: false,
      error: serializeSupabaseError(error)
    };
    if (isMissingSchemaError(error)) {
      logCanonicalSiteResolutionFailed({
        identity,
        createIfMissing,
        account,
        requestId,
        errorCode: 'SITE_QUOTA_V2_UNAVAILABLE'
      });
      return {
        site: null,
        identity,
        matchedBy: null,
        created: false,
        error: 'SITE_QUOTA_V2_UNAVAILABLE',
        diagnostics: finalizeSiteDiagnostics(diagnostics)
      };
    }
    logCanonicalSiteResolutionFailed({
      identity,
      createIfMissing,
      account,
      requestId,
      errorCode: 'SITE_CREATE_FAILED'
    });
    return {
      site: null,
      identity,
      matchedBy: null,
      created: false,
      error: 'SITE_CREATE_FAILED',
      diagnostics: finalizeSiteDiagnostics(diagnostics)
    };
  }
}

async function selectPlan(supabase, planId) {
  if (!supabase) return null;
  const normalizedPlanId = planId || 'free';
  const { data, error } = await maybeSingle(
    supabase.from('plans').select(PLAN_SELECT).eq('id', normalizedPlanId)
  );
  if (error && !isMissingSchemaError(error)) {
    logger.warn('[siteQuota] plan lookup failed', { planId: normalizedPlanId, error: error.message });
  }
  return data || null;
}

async function selectActiveSiteSubscription(supabase, siteId) {
  if (!supabase || !siteId) return null;
  const { data, error } = await supabase
    .from('site_subscriptions')
    .select('id, site_id, plan_id, stripe_customer_id, stripe_subscription_id, status, billing_interval, current_period_start, current_period_end, cancel_at_period_end')
    .eq('site_id', siteId)
    .in('status', ['active', 'trialing', 'past_due'])
    .order('current_period_end', { ascending: false, nullsFirst: false })
    .limit(1);

  if (error && !isMissingSchemaError(error)) {
    logger.warn('[siteQuota] subscription lookup failed', { siteId, error: error.message });
    return null;
  }

  return Array.isArray(data) && data.length ? data[0] : null;
}

async function selectCurrentSiteQuota(supabase, siteId, { quotaPeriodStart, quotaPeriodEnd }) {
  if (!supabase || !siteId || !quotaPeriodStart || !quotaPeriodEnd) return null;
  const { data, error } = await maybeSingle(
    supabase
      .from('site_quotas')
      .select('id, site_id, quota_period_start, quota_period_end, monthly_included_credits, purchased_credits_balance, bonus_credits_balance, used_credits, remaining_credits, reset_source')
      .eq('site_id', siteId)
      .eq('quota_period_start', quotaPeriodStart)
      .eq('quota_period_end', quotaPeriodEnd)
  );

  if (error && !isMissingSchemaError(error)) {
    logger.warn('[siteQuota] site quota lookup failed', {
      siteId,
      quotaPeriodStart,
      quotaPeriodEnd,
      error: error.message
    });
  }

  return data || null;
}

async function ensureCurrentSiteQuota(supabase, siteId, {
  quotaPeriodStart,
  quotaPeriodEnd,
  monthlyIncludedCredits
} = {}) {
  if (!supabase || !siteId || !quotaPeriodStart || !quotaPeriodEnd) return null;

  const existing = await selectCurrentSiteQuota(supabase, siteId, { quotaPeriodStart, quotaPeriodEnd });
  if (existing) return existing;

  const now = new Date().toISOString();
  const parsedIncludedCredits = Number(monthlyIncludedCredits || 0);
  const includedCredits = Number.isFinite(parsedIncludedCredits)
    ? Math.max(0, parsedIncludedCredits)
    : 0;
  const payload = {
    site_id: siteId,
    quota_period_start: quotaPeriodStart,
    quota_period_end: quotaPeriodEnd,
    monthly_included_credits: includedCredits,
    purchased_credits_balance: 0,
    bonus_credits_balance: 0,
    used_credits: 0,
    remaining_credits: includedCredits,
    reset_source: 'quota_read_healing',
    created_at: now,
    updated_at: now
  };

  const { data, error } = await supabase
    .from('site_quotas')
    .insert(payload)
    .select('id, site_id, quota_period_start, quota_period_end, monthly_included_credits, purchased_credits_balance, bonus_credits_balance, used_credits, remaining_credits, reset_source')
    .single();

  if (error && isUniqueViolation(error)) {
    logger.info('[siteQuota] site quota init reused existing row after unique race', {
      site_id: siteId,
      quota_period_start: quotaPeriodStart,
      quota_period_end: quotaPeriodEnd
    });
    return selectCurrentSiteQuota(supabase, siteId, { quotaPeriodStart, quotaPeriodEnd });
  }

  if (error) {
    logger.error('[siteQuota] site quota init failed', {
      site_id: siteId,
      quota_period_start: quotaPeriodStart,
      quota_period_end: quotaPeriodEnd,
      monthly_included_credits: includedCredits,
      error: serializeSupabaseError(error)
    });
    return null;
  }

  logger.info('[siteQuota] site quota initialized', {
    site_id: siteId,
    quota_period_start: quotaPeriodStart,
    quota_period_end: quotaPeriodEnd,
    monthly_included_credits: includedCredits
  });

  return data || payload;
}

async function selectLatestTrial(supabase, siteId) {
  if (!supabase || !siteId) return null;
  const { data, error } = await supabase
    .from('site_trials')
    .select('id, site_id, trial_type, total_trial_credits, used_trial_credits, status, started_at, exhausted_at, created_at')
    .eq('site_id', siteId)
    .eq('trial_type', 'initial')
    .order('status', { ascending: true })
    .order('created_at', { ascending: false })
    .limit(1);

  if (error && !isMissingSchemaError(error)) {
    logger.warn('[siteQuota] site trial lookup failed', {
      siteId,
      error: error.message
    });
    return null;
  }

  return Array.isArray(data) && data.length ? data[0] : null;
}

async function ensureInitialSiteTrial(supabase, siteId, {
  trialCredits = getAnonymousTrialLimit(),
  requestId = null
} = {}) {
  if (!supabase || !siteId) {
    return {
      data: null,
      created: false,
      error: 'SITE_NOT_FOUND',
      status: 404,
      message: 'Site id required for trial initialization'
    };
  }

  const existing = await selectLatestTrial(supabase, siteId);
  if (existing) {
    logger.info('[siteQuota] site trial reused', {
      site_id: siteId,
      request_id: requestId || null,
      trial_id: existing.id || null,
      status: existing.status || null,
      used_trial_credits: existing.used_trial_credits ?? null,
      total_trial_credits: existing.total_trial_credits ?? null
    });
    return {
      data: existing,
      created: false,
      error: null
    };
  }

  const normalizedTrialCredits = normalizeTrialCredits(trialCredits);
  const now = new Date().toISOString();
  const payload = {
    site_id: siteId,
    trial_type: 'initial',
    total_trial_credits: normalizedTrialCredits,
    used_trial_credits: 0,
    status: 'active',
    started_at: now,
    created_at: now,
    updated_at: now
  };

  const { data, error } = await supabase
    .from('site_trials')
    .insert(payload)
    .select('id, site_id, trial_type, total_trial_credits, used_trial_credits, status, started_at, exhausted_at, created_at')
    .single();

  if (error && isUniqueViolation(error)) {
    const racedTrial = await selectLatestTrial(supabase, siteId);
    if (racedTrial) {
      logger.info('[siteQuota] site trial init reused existing row after unique race', {
        site_id: siteId,
        request_id: requestId || null,
        trial_id: racedTrial.id || null
      });
      return {
        data: racedTrial,
        created: false,
        error: null
      };
    }
  }

  if (error) {
    const errorCode = isMissingSchemaError(error)
      ? 'SITE_QUOTA_V2_UNAVAILABLE'
      : 'SITE_TRIAL_INIT_FAILED';
    logger.error('[siteQuota] site trial init failed', {
      site_id: siteId,
      request_id: requestId || null,
      trial_credits: normalizedTrialCredits,
      error_code: errorCode,
      error: serializeSupabaseError(error)
    });
    return {
      data: null,
      created: false,
      error: errorCode,
      status: 500,
      message: error.message || 'Site trial initialization failed',
      rawError: error
    };
  }

  logger.info('[siteQuota] site trial initialized', {
    site_id: siteId,
    request_id: requestId || null,
    trial_id: data?.id || null,
    trial_credits: normalizedTrialCredits
  });

  return {
    data: data || payload,
    created: true,
    error: null
  };
}

function resolveQuotaWindowFromSubscription(subscription, now = new Date()) {
  if (subscription?.current_period_start && subscription?.current_period_end) {
    return {
      quotaPeriodStart: subscription.current_period_start,
      quotaPeriodEnd: subscription.current_period_end
    };
  }

  const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0));
  const periodEnd = new Date(periodStart);
  periodEnd.setUTCMonth(periodEnd.getUTCMonth() + 1);
  return {
    quotaPeriodStart: periodStart.toISOString(),
    quotaPeriodEnd: periodEnd.toISOString()
  };
}

async function getSiteQuotaStatus(supabase, {
  account = null,
  licenseKey = null,
  siteIdentity,
  createIfMissing = false,
  quotaMode = 'site',
  requestId = null
} = {}) {
  const resolved = await resolveCanonicalSite(supabase, siteIdentity, {
    createIfMissing,
    legacyLicenseKey: licenseKey || account?.license_key || null,
    account,
    requestId
  });

  if (resolved.error) {
    return {
      error: resolved.error,
      status: resolved.error === 'DEVELOPMENT_SITE_NOT_ALLOWED' ? 403 : 404,
      message: resolved.error === 'DEVELOPMENT_SITE_NOT_ALLOWED'
        ? 'Development and localhost installs cannot claim production quota'
        : 'Canonical site not found'
    };
  }

  const site = resolved.site;
  const subscription = await selectActiveSiteSubscription(supabase, site.id);
  const legacyAccount = account || await fetchAccountByLicenseKey(supabase, licenseKey || site.license_key);
  const effectivePlanId = subscription?.plan_id || legacyAccount?.plan || 'free';
  const plan = await selectPlan(supabase, effectivePlanId);
  const quotaWindow = resolveQuotaWindowFromSubscription(subscription);
  const monthlyIncludedCredits = plan?.monthly_included_credits ?? getLimits(effectivePlanId).credits;
  const siteQuota = await ensureCurrentSiteQuota(supabase, site.id, {
    ...quotaWindow,
    monthlyIncludedCredits
  });
  let trial = null;
  if (quotaMode === 'trial') {
    const trialInit = await ensureInitialSiteTrial(supabase, site.id, {
      trialCredits: getAnonymousTrialLimit(),
      requestId
    });
    if (trialInit.error) {
      return {
        error: trialInit.error,
        status: trialInit.status || 500,
        message: trialInit.message || 'Site trial unavailable',
        site
      };
    }
    trial = trialInit.data;
  } else {
    trial = await selectLatestTrial(supabase, site.id);
  }
  const totalLimit = siteQuota
    ? Number(siteQuota.monthly_included_credits || 0)
      + Number(siteQuota.purchased_credits_balance || 0)
      + Number(siteQuota.bonus_credits_balance || 0)
    : monthlyIncludedCredits;
  const effectiveRead = quotaMode === 'trial'
    ? {
        used: Number(siteQuota?.used_credits || 0),
        remaining: siteQuota?.remaining_credits ?? Math.max(totalLimit - Number(siteQuota?.used_credits || 0), 0)
      }
    : await selectEffectiveSiteQuotaRead(supabase, {
        site,
        siteQuota,
        account: legacyAccount || account || null,
        licenseKey: licenseKey || site.license_key || legacyAccount?.license_key || null,
        quotaPeriodStart: quotaWindow.quotaPeriodStart,
        quotaPeriodEnd: quotaWindow.quotaPeriodEnd,
        totalLimit,
        requestId
      });
  const creditsUsed = effectiveRead.used;
  const creditsRemaining = effectiveRead.remaining;

  return {
    error: null,
    site,
    account: legacyAccount || null,
    subscription: subscription || null,
    plan_type: effectivePlanId,
    license_status: legacyAccount?.status || 'active',
    credits_used: creditsUsed,
    credits_remaining: creditsRemaining,
    total_limit: totalLimit,
    reset_date: quotaWindow.quotaPeriodEnd,
    warning_threshold: 0.9,
    is_near_limit: totalLimit > 0 ? creditsUsed / totalLimit >= 0.9 : false,
    site_quota: {
      site_id: site.id,
      site_hash: site.site_hash,
      quota_period_start: quotaWindow.quotaPeriodStart,
      quota_period_end: quotaWindow.quotaPeriodEnd,
      monthly_included_credits: siteQuota?.monthly_included_credits ?? monthlyIncludedCredits,
      purchased_credits_balance: siteQuota?.purchased_credits_balance ?? 0,
      bonus_credits_balance: siteQuota?.bonus_credits_balance ?? 0,
      used_credits: creditsUsed,
      remaining_credits: creditsRemaining
    },
    trial: trial
      ? {
          status: trial.status,
          total_trial_credits: trial.total_trial_credits,
          used_trial_credits: trial.used_trial_credits,
          remaining_trial_credits: Math.max((trial.total_trial_credits || 0) - (trial.used_trial_credits || 0), 0)
        }
      : null
  };
}

async function reserveSiteCredits(supabase, {
  account = null,
  licenseKey = null,
  siteIdentity,
  creditsNeeded = 1,
  quotaMode = 'site',
  idempotencyKey = null,
  requestFingerprint = null,
  requestMetadata = {},
  requestId = null
} = {}) {
  if (!supabase?.rpc) {
    return { error: 'SITE_QUOTA_V2_UNAVAILABLE', status: 500, message: 'Atomic site quota functions unavailable' };
  }

  const resolved = await resolveCanonicalSite(supabase, siteIdentity, {
    createIfMissing: true,
    legacyLicenseKey: licenseKey || account?.license_key || null,
    account,
    requestId
  });

  if (resolved.error || !resolved.site?.id) {
    return {
      error: resolved.error || 'SITE_NOT_FOUND',
      status: resolved.error === 'DEVELOPMENT_SITE_NOT_ALLOWED' ? 403 : 404,
      message: resolved.error === 'DEVELOPMENT_SITE_NOT_ALLOWED'
        ? 'Development and localhost installs cannot claim production quota'
        : 'Canonical site not resolved'
    };
  }

  const trialCredits = getAnonymousTrialLimit();
  if (quotaMode === 'trial') {
    const trialInit = await ensureInitialSiteTrial(supabase, resolved.site.id, {
      trialCredits,
      requestId
    });
    if (trialInit.error) {
      return {
        error: trialInit.error,
        status: trialInit.status || 500,
        message: trialInit.message || 'Site trial initialization failed',
        site: resolved.site
      };
    }
  }

  const rpcPayload = {
    p_site_id: resolved.site.id,
    p_user_id: account?.id || null,
    p_credits: creditsNeeded,
    p_idempotency_key: idempotencyKey || null,
    p_request_fingerprint: requestFingerprint || null,
    p_request_metadata: requestMetadata || {},
    p_quota_mode: quotaMode === 'trial' ? 'trial' : 'site',
    p_trial_credits: trialCredits
  };

  const { data, error } = await supabase.rpc('bbai_reserve_site_generation', rpcPayload);
  if (error) {
    if (isMissingSchemaError(error)) {
      return {
        error: 'SITE_QUOTA_V2_UNAVAILABLE',
        status: 500,
        message: error.message
      };
    }

    logger.error('[siteQuota] reserve rpc failed', {
      siteId: resolved.site.id,
      site_hash: resolved.site.site_hash || null,
      quota_mode: rpcPayload.p_quota_mode,
      error: serializeSupabaseError(error)
    });
    return {
      error: 'SITE_QUOTA_RESERVE_FAILED',
      status: 500,
      message: error.message
    };
  }

  if (!data?.ok) {
    logger.warn('[siteQuota] reserve rpc rejected request', {
      site_id: resolved.site.id,
      site_hash: resolved.site.site_hash || null,
      quota_mode: rpcPayload.p_quota_mode,
      generation_request_id: data?.generation_request_id || null,
      response_code: data?.code || 'QUOTA_EXCEEDED',
      remaining_credits: data?.remaining_credits ?? null,
      total_limit: data?.total_limit ?? null
    });
    return {
      error: data?.code || 'QUOTA_EXCEEDED',
      status: data?.code === 'TRIAL_EXHAUSTED' || data?.code === 'QUOTA_EXCEEDED' ? 402 : 400,
      message: data?.code === 'TRIAL_EXHAUSTED' ? 'Trial quota exhausted' : 'Quota exceeded',
      payload: data,
      site: resolved.site
    };
  }

  logger.info('[siteQuota] reserve rpc succeeded', {
    site_id: resolved.site.id,
    site_hash: resolved.site.site_hash || null,
    quota_mode: rpcPayload.p_quota_mode,
    generation_request_id: data?.generation_request_id || null,
    quota_source: data?.quota_source || null,
    remaining_credits: data?.remaining_credits ?? null,
    total_limit: data?.total_limit ?? null,
    p_trial_credits: rpcPayload.p_quota_mode === 'trial' ? rpcPayload.p_trial_credits : null
  });

  return {
    error: null,
    site: resolved.site,
    account: account || null,
    reservation: data,
    matchedBy: resolved.matchedBy,
    created: resolved.created
  };
}

async function finalizeSiteGeneration(supabase, {
  generationRequestId,
  success,
  finalMetadata = {}
} = {}) {
  if (!generationRequestId || !supabase?.rpc) {
    return { error: null };
  }

  const { data, error } = await supabase.rpc('bbai_finalize_site_generation', {
    p_generation_request_id: generationRequestId,
    p_success: Boolean(success),
    p_final_metadata: finalMetadata || {}
  });

  if (error && !isMissingSchemaError(error)) {
    logger.warn('[siteQuota] finalize generation failed', {
      generationRequestId,
      success: Boolean(success),
      error: serializeSupabaseError(error)
    });
    return { error };
  }

  logger.info('[siteQuota] finalize generation rpc completed', {
    generation_request_id: generationRequestId,
    success: Boolean(success),
    status: data?.status || null,
    skipped_missing_schema: Boolean(error && isMissingSchemaError(error))
  });

  return { data, error };
}

async function reconcileBillingEntitlement(supabase, {
  siteId,
  stripeEventId,
  planId,
  purchaseType,
  billingInterval = null,
  stripeCustomerId = null,
  stripeSubscriptionId = null,
  subscriptionStatus = 'active',
  currentPeriodStart = null,
  currentPeriodEnd = null,
  metadata = {}
} = {}) {
  if (!siteId || !stripeEventId || !supabase?.rpc) {
    return { error: null, skipped: true };
  }

  const { data, error } = await supabase.rpc('bbai_apply_site_billing_event', {
    p_site_id: siteId,
    p_stripe_event_id: stripeEventId,
    p_plan_id: planId,
    p_purchase_type: purchaseType,
    p_billing_interval: billingInterval,
    p_stripe_customer_id: stripeCustomerId,
    p_stripe_subscription_id: stripeSubscriptionId,
    p_subscription_status: subscriptionStatus,
    p_current_period_start: currentPeriodStart,
    p_current_period_end: currentPeriodEnd,
    p_metadata: metadata || {}
  });

  if (error && !isMissingSchemaError(error)) {
    logger.warn('[siteQuota] billing reconciliation failed', {
      siteId,
      stripeEventId,
      error: error.message
    });
    return { error };
  }

  return {
    data,
    error,
    skipped: Boolean(error && isMissingSchemaError(error))
  };
}

async function syncLegacySitePointers(supabase, {
  site,
  account,
  subscription = null,
  planId = null,
  diagnostics = null
} = {}) {
  if (!supabase || !site?.id) return;
  const sitePointerDiagnostics = ensureDiagnosticsBucket(diagnostics, 'legacy_site_pointer_sync');
  const licensePointerDiagnostics = ensureDiagnosticsBucket(diagnostics, 'legacy_license_pointer_sync');

  if (account?.license_key && (!site.license_key || site.license_key === account.license_key)) {
    try {
      if (sitePointerDiagnostics) {
        sitePointerDiagnostics.attempted = true;
      }
      const siteUpdate = supabase
        .from('sites')
        .update({
          license_key: account.license_key,
          owner_user_id: site.owner_user_id || account.id || null,
          updated_at: new Date().toISOString(),
          last_seen_at: new Date().toISOString()
        })
        .eq('id', site.id);
      if (siteUpdate && typeof siteUpdate.then === 'function') {
        await siteUpdate;
      }
      if (sitePointerDiagnostics) {
        sitePointerDiagnostics.success = true;
        sitePointerDiagnostics.error = null;
      }
      logger.info('[site] legacy_site_pointer_sync_succeeded', {
        site_id: site.id,
        site_hash: site.site_hash || null,
        account_id: account.id || null
      });
    } catch (error) {
      if (isMissingSchemaError(error)) {
        logLegacySitesFallback('legacy_site_pointer_sync_v2_unavailable', {
          column: 'id',
          value: site.id,
          error,
          siteHash: site.site_hash || null,
          siteUrl: site.site_url || null
        });
        try {
          const legacySiteUpdate = supabase
            .from('sites')
            .update({
              license_key: account.license_key,
              status: site.status || 'active',
              last_activity_at: new Date().toISOString()
            })
            .eq('id', site.id);
          if (legacySiteUpdate && typeof legacySiteUpdate.then === 'function') {
            await legacySiteUpdate;
          }
          if (sitePointerDiagnostics) {
            sitePointerDiagnostics.success = true;
            sitePointerDiagnostics.error = null;
            sitePointerDiagnostics.schema_mode = 'legacy';
          }
          logger.info('[site] legacy_site_pointer_sync_succeeded', {
            site_id: site.id,
            site_hash: site.site_hash || null,
            account_id: account.id || null,
            schema_mode: 'legacy'
          });
          return;
        } catch (legacyError) {
          if (sitePointerDiagnostics) {
            sitePointerDiagnostics.success = false;
            sitePointerDiagnostics.error = serializeSupabaseError(legacyError);
            sitePointerDiagnostics.schema_mode = 'legacy';
          }
          logger.error('[site] legacy_site_pointer_sync_failed', {
            site_id: site.id,
            site_hash: site.site_hash || null,
            account_id: account.id || null,
            schema_mode: 'legacy',
            error: serializeSupabaseError(legacyError)
          });
          return;
        }
      }
      if (sitePointerDiagnostics) {
        sitePointerDiagnostics.success = false;
        sitePointerDiagnostics.error = serializeSupabaseError(error);
      }
      logger.error('[site] legacy_site_pointer_sync_failed', {
        site_id: site.id,
        site_hash: site.site_hash || null,
        account_id: account.id || null,
        error: serializeSupabaseError(error)
      });
    }
  }

  if (!account?.id) return;

  const licenseUpdates = {
    stripe_customer_id: subscription?.stripe_customer_id || account.stripe_customer_id || null,
    stripe_subscription_id: subscription?.stripe_subscription_id || account.stripe_subscription_id || null,
    billing_cycle: subscription?.billing_interval === 'year' ? 'yearly' : subscription?.billing_interval === 'month' ? 'monthly' : account.billing_cycle || null
  };

  if (planId && !['free', 'credits'].includes(planId)) {
    licenseUpdates.plan = planId;
    licenseUpdates.status = subscription?.status || 'active';
  }

  try {
    if (licensePointerDiagnostics) {
      licensePointerDiagnostics.attempted = true;
    }
    const licenseUpdate = supabase
      .from('licenses')
      .update(licenseUpdates)
      .eq('id', account.id);
    if (licenseUpdate && typeof licenseUpdate.then === 'function') {
      await licenseUpdate;
    }
    if (licensePointerDiagnostics) {
      licensePointerDiagnostics.success = true;
      licensePointerDiagnostics.error = null;
    }
    logger.info('[site] legacy_license_pointer_sync_succeeded', {
      account_id: account.id,
      site_id: site.id,
      plan_id: planId || null
    });
  } catch (error) {
    if (licensePointerDiagnostics) {
      licensePointerDiagnostics.success = false;
      licensePointerDiagnostics.error = serializeSupabaseError(error);
    }
    logger.error('[site] legacy_license_pointer_sync_failed', {
      account_id: account.id,
      site_id: site.id,
      plan_id: planId || null,
      error: serializeSupabaseError(error)
    });
  }
}

module.exports = {
  buildSiteIdentity,
  fetchAccountById,
  fetchAccountByLicenseKey,
  getSiteQuotaStatus,
  hashRequestFingerprint,
  ensureInitialSiteTrial,
  isMissingSchemaError,
  recordSiteAudit,
  reconcileBillingEntitlement,
  resolveCanonicalSite,
  reserveSiteCredits,
  ensureSiteMembership,
  finalizeSiteGeneration,
  syncLegacySitePointers,
  selectActiveSiteSubscription
};
