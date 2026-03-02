const { getLimits } = require('./license');
const logger = require('../lib/logger');

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
  if (!siteHash || typeof siteHash !== 'string' || siteHash.trim() === '') {
    return { data: null, error: { message: 'site_hash is required' } };
  }

  const sanitizedHash = siteHash.trim().substring(0, 255);
  const sanitizedUrl = siteUrl ? String(siteUrl).trim().substring(0, 500) : null;
  const sanitizedFp = fingerprint ? String(fingerprint).trim().substring(0, 255) : null;

  // Check if site already exists.
  const { data: existing, error: selectErr } = await supabase
    .from('sites')
    .select('id, site_hash, license_key, site_url, status')
    .eq('site_hash', sanitizedHash)
    .maybeSingle();

  if (selectErr) {
    logger.error('[Site] findOrCreateTrialSite select failed', { error: selectErr.message });
    return { data: null, error: selectErr };
  }

  if (existing) {
    // Update activity timestamp and enrich optional fields.
    const updates = { last_activity_at: new Date().toISOString() };
    if (sanitizedUrl && sanitizedUrl !== 'unknown' && (!existing.site_url || existing.site_url === 'unknown')) {
      updates.site_url = sanitizedUrl;
    }
    await supabase.from('sites').update(updates).eq('site_hash', sanitizedHash);
    return { data: existing, error: null };
  }

  // Insert new trial site (no license_key).
  const { data: inserted, error: insertErr } = await supabase
    .from('sites')
    .insert({
      site_hash: sanitizedHash,
      site_url: sanitizedUrl || null,
      fingerprint: sanitizedFp,
      status: 'active',
      activated_at: new Date().toISOString(),
      last_activity_at: new Date().toISOString()
    })
    .select()
    .single();

  // Handle race: another request inserted between our SELECT and INSERT.
  if (insertErr && insertErr.code === '23505') {
    logger.info('[Site] Race condition on trial site insert, fetching existing', { site_hash: sanitizedHash });
    const { data: raceData } = await supabase
      .from('sites')
      .select('id, site_hash, license_key, site_url, status')
      .eq('site_hash', sanitizedHash)
      .single();
    return { data: raceData, error: null };
  }

  if (insertErr) {
    logger.error('[Site] findOrCreateTrialSite insert failed', { error: insertErr.message, code: insertErr.code });
    return { data: null, error: insertErr };
  }

  logger.info('[Site] Trial site created', { site_hash: sanitizedHash, id: inserted?.id });
  return { data: inserted, error: null };
}

async function createSite(supabase, { licenseKey, siteHash, siteUrl, siteName, fingerprint, plan }) {
  const { data, error } = await supabase
    .from('sites')
    .insert({
      license_key: licenseKey,
      site_hash: siteHash,
      site_url: siteUrl,
      site_name: siteName,
      fingerprint,
      plan,
      status: 'active'
    })
    .select()
    .single();
  return { data, error };
}

async function getSites(supabase, { licenseKey }) {
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
    .update({ last_activity_at: new Date().toISOString() })
    .eq('site_hash', siteHash);
  return { error };
}

module.exports = {
  findOrCreateTrialSite,
  createSite,
  getSites,
  setSiteQuota,
  updateSiteActivity
};
