#!/usr/bin/env node

const { buildSiteIdentity } = require('../fresh-stack/lib/siteIdentity');
const {
  createSupabase,
  hasFlag
} = require('./_site-quota-utils');

async function ensureMembership(supabase, siteId, userId, role = 'owner') {
  if (!siteId || !userId) return false;

  const { data: existing, error: existingError } = await supabase
    .from('site_memberships')
    .select('id')
    .eq('site_id', siteId)
    .eq('user_id', userId)
    .maybeSingle();

  if (existingError && existingError.code !== '42P01') {
    throw existingError;
  }

  if (existing?.id) {
    return false;
  }

  const { error } = await supabase
    .from('site_memberships')
    .insert({
      site_id: siteId,
      user_id: userId,
      role,
      invited_by_user_id: userId
    });

  if (error && error.code !== '42P01') {
    throw error;
  }

  return true;
}

async function main() {
  const supabase = createSupabase();
  const write = hasFlag('--write');
  const summary = {
    sitesUpdated: 0,
    sitesCreatedFromTrialUsage: 0,
    membershipsCreated: 0
  };

  const { data: sites, error: siteError } = await supabase
    .from('sites')
    .select('id, license_key, owner_user_id, site_hash, wp_install_uuid, site_url, site_fingerprint, fingerprint, normalized_site_url, canonical_domain, first_seen_at, last_seen_at, environment');
  if (siteError) throw siteError;

  const { data: licenses, error: licenseError } = await supabase
    .from('licenses')
    .select('id, license_key');
  if (licenseError) throw licenseError;
  const accountByLicenseKey = new Map((licenses || []).map((license) => [license.license_key, license]));

  for (const site of sites || []) {
    const identity = buildSiteIdentity({
      siteHash: site.site_hash,
      installUuid: site.wp_install_uuid || site.site_hash,
      siteUrl: site.site_url,
      siteFingerprint: site.site_fingerprint || site.fingerprint,
      allowDevelopment: true
    });

    const updates = {};
    if (!site.wp_install_uuid && identity.wpInstallUuid) updates.wp_install_uuid = identity.wpInstallUuid;
    if (!site.normalized_site_url && identity.normalizedSiteUrl) updates.normalized_site_url = identity.normalizedSiteUrl;
    if (!site.canonical_domain && identity.canonicalDomain) updates.canonical_domain = identity.canonicalDomain;
    if (!site.site_fingerprint && identity.siteFingerprint) updates.site_fingerprint = identity.siteFingerprint;
    if (!site.fingerprint && identity.siteFingerprint) updates.fingerprint = identity.siteFingerprint;
    if (!site.environment) updates.environment = identity.isDevelopment ? 'development' : 'production';
    if (!site.first_seen_at) updates.first_seen_at = site.last_seen_at || new Date().toISOString();
    if (!site.last_seen_at) updates.last_seen_at = site.first_seen_at || new Date().toISOString();
    if (Object.keys(updates).length) {
      summary.sitesUpdated += 1;
      if (write) {
        const { error } = await supabase.from('sites').update(updates).eq('id', site.id);
        if (error) throw error;
      }
    }

    const account = site.license_key ? accountByLicenseKey.get(site.license_key) : null;
    if (account?.id) {
      const created = write
        ? await ensureMembership(supabase, site.id, account.id, site.owner_user_id === account.id ? 'owner' : 'member')
        : false;
      if (created) summary.membershipsCreated += 1;
    }
  }

  const { data: trialUsage, error: trialError } = await supabase
    .from('trial_usage')
    .select('site_hash, site_url, site_fingerprint, created_at')
    .order('created_at', { ascending: false });
  if (trialError && trialError.code !== '42P01') throw trialError;

  const latestTrialByHash = new Map();
  for (const row of trialUsage || []) {
    if (!row.site_hash || latestTrialByHash.has(row.site_hash)) continue;
    latestTrialByHash.set(row.site_hash, row);
  }

  for (const row of latestTrialByHash.values()) {
    const { data: existing, error } = await supabase
      .from('sites')
      .select('id')
      .eq('site_hash', row.site_hash)
      .maybeSingle();

    if (error) throw error;
    if (existing?.id) continue;

    const identity = buildSiteIdentity({
      siteHash: row.site_hash,
      installUuid: row.site_hash,
      siteUrl: row.site_url,
      siteFingerprint: row.site_fingerprint,
      allowDevelopment: true
    });

    summary.sitesCreatedFromTrialUsage += 1;
    if (write) {
      const { error: insertError } = await supabase
        .from('sites')
        .insert({
          site_hash: identity.siteHash,
          wp_install_uuid: identity.wpInstallUuid,
          site_url: identity.siteUrl || identity.normalizedSiteUrl || null,
          normalized_site_url: identity.normalizedSiteUrl,
          canonical_domain: identity.canonicalDomain,
          site_fingerprint: identity.siteFingerprint,
          fingerprint: identity.siteFingerprint,
          status: 'active',
          first_seen_at: row.created_at || new Date().toISOString(),
          last_seen_at: row.created_at || new Date().toISOString(),
          updated_at: new Date().toISOString(),
          environment: identity.isDevelopment ? 'development' : 'production'
        });
      if (insertError && insertError.code !== '23505') throw insertError;
    }
  }

  console.log(JSON.stringify({ dryRun: !write, summary }, null, 2));
}

main().catch((error) => {
  console.error('[backfill-sites] failed:', error.message);
  process.exit(1);
});
