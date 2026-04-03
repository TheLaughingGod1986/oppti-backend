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

const ACCOUNT_SELECT = 'id, email, license_key, plan, status, billing_cycle, billing_day_of_month, stripe_customer_id, stripe_subscription_id';
const PLAN_SELECT = 'id, display_name, monthly_included_credits, credit_grant_amount, billing_interval_default, is_paid';
const ROLE_RANK = {
  member: 1,
  admin: 2,
  owner: 3
};

function isUniqueViolation(error) {
  return Boolean(error && error.code === '23505');
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
    logger.warn('[siteQuota] account lookup by license key failed', { licenseKey, error: error.message });
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

async function fetchSiteByColumn(supabase, column, value) {
  if (!supabase || !column || !value) return { site: null, candidates: [] };
  const { data, error } = await supabase
    .from('sites')
    .select(SITE_SELECT)
    .eq(column, value);

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

async function reconcileResolvedSite(supabase, site, identity, { legacyLicenseKey = null, account = null } = {}) {
  if (!supabase || !site?.id) return site;

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
    return site;
  }

  const { data, error } = await supabase
    .from('sites')
    .update(updates)
    .eq('id', site.id)
    .select(SITE_SELECT)
    .single();

  if (error) {
    logger.warn('[siteQuota] failed to reconcile resolved site', {
      siteId: site.id,
      error: error.message
    });
    return {
      ...site,
      ...updates
    };
  }

  return data || {
    ...site,
    ...updates
  };
}

async function createCanonicalSite(supabase, identity, { legacyLicenseKey = null, account = null } = {}) {
  const now = new Date().toISOString();
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

  if (error && isUniqueViolation(error)) {
    logger.info('[siteQuota] Site create reused existing row after unique race', {
      site_hash: payload.site_hash,
      site_url: payload.site_url || null,
      canonical_domain: payload.canonical_domain || null
    });
    return null;
  }

  if (error) {
    logger.error('[siteQuota] Site creation failed', {
      site_hash: payload.site_hash,
      site_url: payload.site_url || null,
      canonical_domain: payload.canonical_domain || null,
      error: serializeSupabaseError(error)
    });
    throw error;
  }

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
  invitedByUserId = null
} = {}) {
  if (!supabase || !siteId || !userId) return null;

  const { data: existing, error: existingError } = await maybeSingle(
    supabase.from('site_memberships').select('id, role, site_id, user_id').eq('site_id', siteId).eq('user_id', userId)
  );

  if (existingError && !isMissingSchemaError(existingError)) {
    logger.warn('[siteQuota] membership lookup failed', {
      siteId,
      userId,
      error: existingError.message
    });
  }

  if (existing) {
    if ((ROLE_RANK[role] || 0) <= (ROLE_RANK[existing.role] || 0)) {
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

    if (error && !isMissingSchemaError(error)) {
      logger.warn('[siteQuota] membership escalation failed', {
        siteId,
        userId,
        role,
        error: error.message
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

  if (error && !isMissingSchemaError(error)) {
    logger.warn('[siteQuota] membership create failed', {
      siteId,
      userId,
      role,
      error: error.message
    });
    return null;
  }

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

  if (!identity.isValid) {
    return {
      site: null,
      identity,
      matchedBy: null,
      created: false,
      error: identity.error || 'INVALID_SITE_IDENTITY'
    };
  }

  if (identity.error === 'DEVELOPMENT_SITE_NOT_ALLOWED') {
    return {
      site: null,
      identity,
      matchedBy: null,
      created: false,
      error: identity.error
    };
  }

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

  if (!site && identity.normalizedSiteUrl) {
    const match = await findSiteMatch(supabase, 'normalized_site_url', identity.normalizedSiteUrl, {
      account,
      requestId
    });
    site = match.site;
    matchedBy = site ? 'normalized_site_url' : matchedBy;
  }

  if (!site && identity.canonicalDomain) {
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

      return {
        site: null,
        identity,
        matchedBy: null,
        created: false,
        error: 'AMBIGUOUS_SITE_MATCH',
        candidates
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
      account
    });

    if (account?.id) {
      await ensureSiteMembership(supabase, {
        siteId: reconciledSite.id,
        userId: account.id,
        role: reconciledSite.owner_user_id === account.id ? 'owner' : 'member',
        invitedByUserId: account.id
      });
    }

    return {
      site: reconciledSite,
      identity,
      matchedBy,
      created: false,
      error: null
    };
  }

  if (!createIfMissing) {
    return {
      site: null,
      identity,
      matchedBy: null,
      created: false,
      error: 'SITE_NOT_FOUND'
    };
  }

  try {
    if (identity.siteHash) {
      const preInsertMatch = await findSiteMatch(supabase, 'site_hash', identity.siteHash, {
        account,
        requestId
      });
      if (preInsertMatch.site) {
        logger.info('[siteQuota] Site creation short-circuited to existing site', {
          site_id: preInsertMatch.site.id,
          site_hash: preInsertMatch.site.site_hash,
          site_url: preInsertMatch.site.site_url || identity.siteUrl || null
        });
        return {
          site: preInsertMatch.site,
          identity,
          matchedBy: 'site_hash_preinsert',
          created: false,
          error: null
        };
      }
    }

    let createdSite = await createCanonicalSite(supabase, identity, { legacyLicenseKey, account });

    if (!createdSite) {
      createdSite = await resolveCanonicalSite(supabase, identity, {
        createIfMissing: false,
        legacyLicenseKey,
        account,
        requestId
      }).then((result) => result.site);
    }

    if (createdSite && account?.id) {
      await ensureSiteMembership(supabase, {
        siteId: createdSite.id,
        userId: account.id,
        role: 'owner',
        invitedByUserId: account.id
      });
    }

    return {
      site: createdSite,
      identity,
      matchedBy: createdSite ? 'created' : null,
      created: Boolean(createdSite),
      error: createdSite ? null : 'SITE_CREATE_FAILED'
    };
  } catch (error) {
    logger.error('[siteQuota] canonical site create failed', {
      site_hash: identity.siteHash || identity.syntheticSiteHash || null,
      site_url: identity.siteUrl || identity.normalizedSiteUrl || null,
      error: serializeSupabaseError(error)
    });
    if (isMissingSchemaError(error)) {
      return {
        site: null,
        identity,
        matchedBy: null,
        created: false,
        error: 'SITE_QUOTA_V2_UNAVAILABLE'
      };
    }
    return {
      site: null,
      identity,
      matchedBy: null,
      created: false,
      error: 'SITE_CREATE_FAILED'
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

async function selectLatestTrial(supabase, siteId) {
  if (!supabase || !siteId) return null;
  const { data, error } = await supabase
    .from('site_trials')
    .select('id, site_id, trial_type, total_trial_credits, used_trial_credits, status, started_at, exhausted_at')
    .eq('site_id', siteId)
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
  const siteQuota = await selectCurrentSiteQuota(supabase, site.id, quotaWindow);
  const trial = await selectLatestTrial(supabase, site.id);
  const totalLimit = siteQuota
    ? Number(siteQuota.monthly_included_credits || 0)
      + Number(siteQuota.purchased_credits_balance || 0)
      + Number(siteQuota.bonus_credits_balance || 0)
    : (plan?.monthly_included_credits ?? getLimits(effectivePlanId).credits);
  const creditsUsed = siteQuota?.used_credits || 0;
  const creditsRemaining = siteQuota?.remaining_credits ?? Math.max(totalLimit - creditsUsed, 0);

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
      monthly_included_credits: siteQuota?.monthly_included_credits ?? plan?.monthly_included_credits ?? getLimits(effectivePlanId).credits,
      purchased_credits_balance: siteQuota?.purchased_credits_balance ?? 0,
      bonus_credits_balance: siteQuota?.bonus_credits_balance ?? 0
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

  const rpcPayload = {
    p_site_id: resolved.site.id,
    p_user_id: account?.id || null,
    p_credits: creditsNeeded,
    p_idempotency_key: idempotencyKey || null,
    p_request_fingerprint: requestFingerprint || null,
    p_request_metadata: requestMetadata || {},
    p_quota_mode: quotaMode === 'trial' ? 'trial' : 'site',
    p_trial_credits: getAnonymousTrialLimit()
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
  planId = null
} = {}) {
  if (!supabase || !site?.id) return;

  if (account?.license_key && (!site.license_key || site.license_key === account.license_key)) {
    try {
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
    } catch (_error) {
      // Best-effort legacy pointer sync.
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
    const licenseUpdate = supabase
      .from('licenses')
      .update(licenseUpdates)
      .eq('id', account.id);
    if (licenseUpdate && typeof licenseUpdate.then === 'function') {
      await licenseUpdate;
    }
  } catch (_error) {
    // Best-effort legacy account sync.
  }
}

module.exports = {
  buildSiteIdentity,
  fetchAccountById,
  fetchAccountByLicenseKey,
  getSiteQuotaStatus,
  hashRequestFingerprint,
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
