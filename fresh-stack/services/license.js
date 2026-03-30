/**
 * License service
 * Responsible for validating and managing license lifecycle.
 * All functions are pure and expect an injected Supabase client.
 */

const { buildSiteIdentity } = require('../lib/siteIdentity');
const {
  ensureSiteMembership,
  recordSiteAudit,
  resolveCanonicalSite,
  syncLegacySitePointers
} = require('./siteQuota');

const PLAN_LIMITS = {
  free: { credits: 50, maxSites: 1 },
  pro: { credits: 1000, maxSites: 1 },
  agency: { credits: 10000, maxSites: null } // null = unlimited
};

function getLimits(plan = 'free') {
  return PLAN_LIMITS[plan] || PLAN_LIMITS.free;
}

/**
 * Fetch a license by key and ensure status is acceptable.
 */
async function validateLicense(supabase, licenseKey) {
  const key = (licenseKey || '').trim();
  if (!key) {
    return { error: 'INVALID_LICENSE', status: 401, message: 'License key is required' };
  }

  const { data: license, error } = await supabase
    .from('licenses')
    .select('*')
    .eq('license_key', key)
    .single();

  if (error || !license) {
    return { error: 'INVALID_LICENSE', status: 401, message: 'License key not found' };
  }

  if (license.status === 'expired') {
    return { error: 'LICENSE_EXPIRED', status: 410, message: 'License expired', license };
  }
  if (['suspended', 'cancelled'].includes(license.status)) {
    return { error: 'LICENSE_SUSPENDED', status: 403, message: 'License suspended or cancelled', license };
  }

  const limits = getLimits(license.plan);
  return { license, limits };
}

/**
 * Create a new license for an email.
 */
async function createLicense(supabase, { email, plan = 'free', passwordHash = null, billingAnchorDate = null } = {}) {
  const { credits, maxSites } = getLimits(plan);
  const { data, error } = await supabase
    .from('licenses')
    .insert({
      email,
      password_hash: passwordHash,
      plan,
      status: 'active',
      billing_anchor_date: billingAnchorDate || new Date().toISOString(),
      billing_day_of_month: billingAnchorDate
        ? new Date(billingAnchorDate).getUTCDate()
        : new Date().getUTCDate(),
      max_sites: maxSites,
    })
    .select()
    .single();

  return { data, error };
}

/**
 * Activate a license on a site, respecting max site limits.
 */
async function activateLicense(supabase, { licenseKey, siteHash, siteUrl, siteName, fingerprint }) {
  const validation = await validateLicense(supabase, licenseKey);
  if (validation.error) return validation;
  const { license } = validation;
  const limits = getLimits(license.plan);
  const identity = buildSiteIdentity({
    siteHash,
    installUuid: siteHash,
    siteUrl,
    siteFingerprint: fingerprint
  });

  if (identity.error === 'DEVELOPMENT_SITE_NOT_ALLOWED') {
    return {
      error: 'DEVELOPMENT_SITE_NOT_ALLOWED',
      status: 403,
      message: 'Development and localhost sites cannot claim production quota'
    };
  }

  const resolved = await resolveCanonicalSite(supabase, identity, {
    createIfMissing: true,
    legacyLicenseKey: license.license_key,
    account: license
  });

  if (resolved.error) {
    return {
      error: resolved.error,
      status: resolved.error === 'AMBIGUOUS_SITE_MATCH' ? 409 : 400,
      message: resolved.error === 'AMBIGUOUS_SITE_MATCH'
        ? 'This site matched multiple existing records and needs manual review'
        : 'Failed to resolve canonical site'
    };
  }

  const sharedSite = Boolean(resolved.site.license_key && resolved.site.license_key !== license.license_key);

  await ensureSiteMembership(supabase, {
    siteId: resolved.site.id,
    userId: license.id,
    role: sharedSite ? 'member' : 'owner',
    invitedByUserId: license.id
  });

  await syncLegacySitePointers(supabase, {
    site: resolved.site,
    account: license
  });

  await recordSiteAudit(supabase, {
    siteId: resolved.site.id,
    actorUserId: license.id,
    eventType: sharedSite ? 'license_activation_joined_existing_site' : 'license_activation_linked_site',
    severity: sharedSite ? 'warn' : 'info',
    metadata: {
      requested_site_hash: siteHash,
      canonical_domain: resolved.site.canonical_domain,
      site_name: siteName || null
    }
  });

  return { license, site: resolved.site, limits, shared_site: sharedSite };
}

/**
 * Deactivate a license from a site.
 */
async function deactivateLicense(supabase, { licenseKey, siteHash }) {
  const validation = await validateLicense(supabase, licenseKey);
  if (validation.error) return validation;
  const account = validation.license;
  const resolved = await resolveCanonicalSite(supabase, buildSiteIdentity({
    siteHash,
    installUuid: siteHash
  }), {
    createIfMissing: false,
    legacyLicenseKey: licenseKey,
    account
  });

  if (resolved.error || !resolved.site) {
    return { error: 'SITE_NOT_FOUND', status: 404, message: 'Site not found' };
  }

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
  if (resolved.site.owner_user_id === account.id) {
    updates.owner_user_id = null;
  }
  if (!memberships.length) {
    updates.status = 'deactivated';
    updates.deactivated_at = new Date().toISOString();
  }

  const { error } = await supabase
    .from('sites')
    .update(updates)
    .eq('id', resolved.site.id);

  if (error) return { error: 'SERVER_ERROR', status: 500, message: error.message };

  await recordSiteAudit(supabase, {
    siteId: resolved.site.id,
    actorUserId: account.id,
    eventType: 'license_site_disconnected',
    severity: 'warn',
    metadata: {
      site_hash: resolved.site.site_hash,
      remaining_memberships: memberships.length
    }
  });

  return { success: true };
}

/**
 * Transfer a license from one site to another.
 */
async function transferLicense(supabase, { licenseKey, oldSiteId, newSiteId, newFingerprint, newSiteUrl, newSiteName }) {
  const validation = await validateLicense(supabase, licenseKey);
  if (validation.error) return validation;

  // Deactivate old
  await supabase
    .from('sites')
    .update({ status: 'deactivated', deactivated_at: new Date().toISOString() })
    .eq('site_hash', oldSiteId)
    .eq('license_key', licenseKey);

  // Activate new
  return activateLicense(supabase, {
    licenseKey,
    siteHash: newSiteId,
    siteUrl: newSiteUrl,
    siteName: newSiteName,
    fingerprint: newFingerprint
  });
}

async function getLicenseDetails(supabase, licenseKey) {
  const { license, error, status, message } = await validateLicense(supabase, licenseKey);
  if (error) return { error, status, message };
  return { license };
}

module.exports = {
  createLicense,
  validateLicense,
  activateLicense,
  deactivateLicense,
  transferLicense,
  getLicenseDetails,
  getLimits
};
