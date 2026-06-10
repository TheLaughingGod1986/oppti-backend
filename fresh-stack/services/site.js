const { getLimits } = require('./planLimits');
const logger = require('../lib/logger');
const { serializeSupabaseError } = require('../lib/supabaseErrors');
const { buildSiteIdentity } = require('../lib/siteIdentity');
const {
  fetchAccountByLicenseKey,
  recordSiteAudit,
  resolveCanonicalSite
} = require('./siteQuota');

/**
 * Race-safe upsert for trial sites (no license key required).
 *
 * - Creates a sites row with license_key=NULL if none exists for siteHash.
 * - If the site already exists (trial or licensed), updates last_activity_at
 *   and enriches site_url / fingerprint when provided.
 * - Handles concurrent inserts via unique-constraint catch + retry.
 *
 * @returns {{ data: object|null, error: object|null }}
 */
async function findOrCreateTrialSite(supabase, { siteHash, siteUrl, fingerprint }) {
  const identity = buildSiteIdentity({
    siteHash,
    installUuid: siteHash,
    siteUrl,
    siteFingerprint: fingerprint,
    // Trial mode must work on localhost/dev installs.
    allowDevelopment: true
  });

  if (!identity.isValid) {
    logger.error('[Site] Trial site identity invalid', {
      site_hash: siteHash || null,
      site_url: siteUrl || null,
      error: identity.error || 'site_hash is required'
    });
    return { data: null, error: { message: identity.error || 'site_hash is required' } };
  }

  const resolved = await resolveCanonicalSite(supabase, identity, {
    createIfMissing: true,
    legacyLicenseKey: null,
    account: null
  });

  if (resolved.error) {
    logger.error('[Site] Trial site resolve failed', {
      site_hash: siteHash || identity.siteHash || null,
      site_url: siteUrl || identity.siteUrl || null,
      error: resolved.error
    });
    return { data: null, error: { message: resolved.error } };
  }

  try {
    const activityUpdate = supabase
      .from('sites')
      .update({
        last_activity_at: new Date().toISOString(),
        last_seen_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .eq('id', resolved.site.id);
    if (activityUpdate && typeof activityUpdate.then === 'function') {
      await activityUpdate;
    }
  } catch (error) {
    logger.warn('[Site] Trial site activity update failed', {
      site_id: resolved.site.id,
      site_hash: resolved.site.site_hash || identity.siteHash || null,
      site_url: resolved.site.site_url || identity.siteUrl || null,
      error: serializeSupabaseError(error)
    });
  }

  logger.info(resolved.created ? '[Site] Trial site created' : '[Site] Trial site reused', {
    site_hash: resolved.site.site_hash,
    site_id: resolved.site.id,
    site_url: resolved.site.site_url || identity.siteUrl || null,
    matched_by: resolved.matchedBy,
    created: Boolean(resolved.created)
  });

  return { data: resolved.site, error: null };
}

async function createSite(supabase, { licenseKey, siteHash, siteUrl, siteName, fingerprint }) {
  const { data, error } = await supabase
    .from('sites')
    .insert({
      license_key: licenseKey,
      site_hash: siteHash,
      site_url: siteUrl,
      site_name: siteName,
      fingerprint,
      status: 'active'
    })
    .select()
    .single();
  return { data, error };
}

async function getSites(supabase, { licenseKey }) {
  const account = await fetchAccountByLicenseKey(supabase, licenseKey);
  if (account?.id) {
    const { data: memberships, error: membershipError } = await supabase
      .from('site_memberships')
      .select('site_id')
      .eq('user_id', account.id);

    if (!membershipError && Array.isArray(memberships) && memberships.length > 0) {
      const siteIds = memberships.map((membership) => membership.site_id).filter(Boolean);
      const { data, error } = await supabase
        .from('sites')
        .select('*')
        .in('id', siteIds)
        .order('activated_at', { ascending: false });
      return { data, error };
    }
  }

  const { data, error } = await supabase
    .from('sites')
    .select('*')
    .eq('license_key', licenseKey)
    .order('activated_at', { ascending: false });
  return { data, error };
}

async function setSiteQuota(supabase, { licenseKey, siteHash, quotaLimit }) {
  const { data: license } = await supabase
    .from('licenses')
    .select('plan')
    .eq('license_key', licenseKey)
    .single();

  if (!license) {
    return { error: 'INVALID_LICENSE', status: 401, message: 'License not found' };
  }
  if (license.plan !== 'agency') {
    return { error: 'PLAN_NOT_SUPPORTED', status: 403, message: 'Per-site quotas require agency plan' };
  }

  const { data, error } = await supabase
    .from('sites')
    .update({ quota_limit: quotaLimit })
    .eq('site_hash', siteHash)
    .eq('license_key', licenseKey)
    .select()
    .single();

  return { data, error };
}

async function updateSiteActivity(supabase, { siteHash }) {
  const { error } = await supabase
    .from('sites')
    .update({
      last_activity_at: new Date().toISOString(),
      last_seen_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    })
    .eq('site_hash', siteHash);
  return { error };
}

/**
 * Deactivate a site (disconnect from license).
 * Sets status to 'deactivated' and deactivated_at timestamp.
 */
async function deactivateSite(supabase, { licenseKey, siteHash }) {
  if (!licenseKey || !siteHash) {
    return { error: 'INVALID_REQUEST', status: 400, message: 'License key and site hash required' };
  }
  const account = await fetchAccountByLicenseKey(supabase, licenseKey);
  const resolved = await resolveCanonicalSite(supabase, buildSiteIdentity({
    siteHash,
    installUuid: siteHash
  }), {
    createIfMissing: false,
    legacyLicenseKey: licenseKey,
    account
  });

  if (resolved.error || !resolved.site) {
    return { error: 'SITE_NOT_FOUND', status: 404, message: 'Site not found or not under this license' };
  }

  if (account?.id) {
    try {
      const membershipDelete = supabase
        .from('site_memberships')
        .delete()
        .eq('site_id', resolved.site.id)
        .eq('user_id', account.id);
      if (membershipDelete && typeof membershipDelete.then === 'function') {
        await membershipDelete;
      }
    } catch (_error) {
      // Best-effort membership cleanup.
    }
  }

  const { data: memberships = [] } = await supabase
    .from('site_memberships')
    .select('id')
    .eq('site_id', resolved.site.id);

  const updates = {
    updated_at: new Date().toISOString()
  };
  if (resolved.site.license_key === licenseKey) {
    updates.license_key = null;
  }
  if (resolved.site.owner_user_id === account?.id) {
    updates.owner_user_id = null;
  }
  if (!memberships.length) {
    updates.status = 'deactivated';
    updates.deactivated_at = new Date().toISOString();
  }

  const { data, error } = await supabase
    .from('sites')
    .update(updates)
    .eq('id', resolved.site.id)
    .select()
    .maybeSingle();
  if (error) {
    return { error: 'SERVER_ERROR', status: 500, message: error.message };
  }

  await recordSiteAudit(supabase, {
    siteId: resolved.site.id,
    actorUserId: account?.id || null,
    eventType: 'site_disconnected',
    severity: 'warn',
    metadata: {
      site_hash: resolved.site.site_hash,
      remaining_memberships: memberships.length
    }
  });

  return { data, error: null };
}

module.exports = {
  findOrCreateTrialSite,
  createSite,
  getSites,
  setSiteQuota,
  updateSiteActivity,
  deactivateSite
};
