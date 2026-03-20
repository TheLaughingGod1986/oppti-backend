/**
 * License service
 * Responsible for validating and managing license lifecycle.
 * All functions are pure and expect an injected Supabase client.
 */

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
      reset_date: billingAnchorDate ? new Date(billingAnchorDate) : null,
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

  // Count active sites
  const { data: sites = [] } = await supabase
    .from('sites')
    .select('id, status')
    .eq('license_key', license.license_key)
    .eq('status', 'active');

  if (limits.maxSites !== null && sites.length >= limits.maxSites) {
    return {
      error: 'MAX_SITES_REACHED',
      status: 403,
      message: 'Maximum number of sites reached for this license',
      max_sites: limits.maxSites,
      activated_sites: sites.length
    };
  }

  // If site already exists and bound to another license, block
  const { data: existingSite } = await supabase
    .from('sites')
    .select('*')
    .eq('site_hash', siteHash)
    .maybeSingle();

  if (existingSite && existingSite.license_key && existingSite.license_key !== license.license_key) {
    return {
      error: 'LICENSE_ALREADY_ACTIVATED',
      status: 409,
      message: 'This site is already activated under a different license',
      activated_site: {
        site_id: existingSite.site_hash,
        site_url: existingSite.site_url,
        activated_at: existingSite.activated_at
      }
    };
  }

  const upsertPayload = {
    site_hash: siteHash,
    site_url: siteUrl,
    site_name: siteName,
    fingerprint,
    license_key: license.license_key,
    plan: license.plan,
    status: 'active',
    activated_at: new Date().toISOString()
  };

  const { data: site, error } = await supabase
    .from('sites')
    .upsert(upsertPayload, { onConflict: 'site_hash' })
    .select()
    .single();

  if (error) {
    return { error: 'SERVER_ERROR', status: 500, message: error.message };
  }

  return { license, site, limits };
}

/**
 * Deactivate a license from a site.
 */
async function deactivateLicense(supabase, { licenseKey, siteHash }) {
  const validation = await validateLicense(supabase, licenseKey);
  if (validation.error) return validation;

  const { error } = await supabase
    .from('sites')
    .update({ status: 'deactivated', deactivated_at: new Date().toISOString() })
    .eq('site_hash', siteHash)
    .eq('license_key', licenseKey);

  if (error) return { error: 'SERVER_ERROR', status: 500, message: error.message };
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
