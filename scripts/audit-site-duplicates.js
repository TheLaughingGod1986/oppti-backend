#!/usr/bin/env node

const {
  createSupabase,
  hasFlag,
  summarizeGroups
} = require('./_site-quota-utils');

// Operator audit helper. Legacy subscriptions are inspected only to measure
// remaining cleanup work, not because runtime billing depends on them.
function pushGroup(map, key, row) {
  if (!key) return;
  if (!map[key]) map[key] = [];
  map[key].push(row);
}

async function main() {
  const supabase = createSupabase();
  const json = hasFlag('--json');

  const { data: sites, error: siteError } = await supabase
    .from('sites')
    .select('id, license_key, owner_user_id, site_hash, wp_install_uuid, site_fingerprint, fingerprint, normalized_site_url, canonical_domain, merged_into_site_id, status, created_at');

  if (siteError) {
    throw siteError;
  }

  const activeSites = (sites || []).filter((site) => !site.merged_into_site_id);
  const groups = {
    byInstallUuid: {},
    bySiteHash: {},
    byFingerprint: {},
    byDomain: {}
  };

  for (const site of activeSites) {
    pushGroup(groups.byInstallUuid, site.wp_install_uuid, site);
    pushGroup(groups.bySiteHash, site.site_hash, site);
    pushGroup(groups.byFingerprint, site.site_fingerprint || site.fingerprint, site);
    pushGroup(groups.byDomain, site.canonical_domain, site);
  }

  const { data: memberships, error: membershipError } = await supabase
    .from('site_memberships')
    .select('site_id, user_id');
  if (membershipError && membershipError.code !== '42P01') {
    throw membershipError;
  }

  const { data: licenses, error: licenseError } = await supabase
    .from('licenses')
    .select('id, email, license_key, stripe_customer_id, stripe_subscription_id');
  if (licenseError) {
    throw licenseError;
  }

  const { data: subscriptions, error: subscriptionError } = await supabase
    .from('subscriptions')
    .select('id, license_key, site_id, stripe_subscription_id, status');
  if (subscriptionError && subscriptionError.code !== '42P01') {
    throw subscriptionError;
  }

  const emailByUserId = new Map((licenses || []).map((license) => [license.id, license.email]));
  const membershipsBySite = new Map();
  for (const membership of memberships || []) {
    if (!membershipsBySite.has(membership.site_id)) membershipsBySite.set(membership.site_id, []);
    membershipsBySite.get(membership.site_id).push(membership.user_id);
  }

  const suspiciousMultiEmailSites = activeSites
    .map((site) => {
      const userIds = membershipsBySite.get(site.id) || [];
      const emails = [...new Set(userIds.map((userId) => emailByUserId.get(userId)).filter(Boolean))];
      return {
        siteId: site.id,
        canonicalDomain: site.canonical_domain,
        emailCount: emails.length,
        emails
      };
    })
    .filter((site) => site.emailCount > 1)
    .sort((left, right) => right.emailCount - left.emailCount);

  const legacyUserLinkedSubscriptions = (subscriptions || [])
    .filter((subscription) => !subscription.site_id && ['active', 'trialing', 'past_due'].includes(subscription.status));

  const report = {
    totalSites: activeSites.length,
    mergedSites: (sites || []).filter((site) => site.merged_into_site_id).length,
    duplicateSitesByInstallUuid: summarizeGroups(groups.byInstallUuid),
    duplicateSitesBySiteHash: summarizeGroups(groups.bySiteHash),
    duplicateSitesByFingerprint: summarizeGroups(groups.byFingerprint),
    duplicateSitesByDomain: summarizeGroups(groups.byDomain),
    sitesWithMultipleUsers: activeSites.filter((site) => (membershipsBySite.get(site.id) || []).length > 1).length,
    suspiciousMultiEmailSites,
    legacyUserLinkedSubscriptionsRemaining: legacyUserLinkedSubscriptions.length,
    legacyUserLinkedSubscriptions
  };

  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log('\nSite duplicate audit');
  console.log('====================');
  console.log(`Active/unmerged sites: ${report.totalSites}`);
  console.log(`Merged sites: ${report.mergedSites}`);
  console.log(`Duplicate install UUID groups: ${report.duplicateSitesByInstallUuid.length}`);
  console.log(`Duplicate site hash groups: ${report.duplicateSitesBySiteHash.length}`);
  console.log(`Duplicate fingerprint groups: ${report.duplicateSitesByFingerprint.length}`);
  console.log(`Duplicate domain groups: ${report.duplicateSitesByDomain.length}`);
  console.log(`Sites with >1 membership: ${report.sitesWithMultipleUsers}`);
  console.log(`Sites with >1 distinct email: ${report.suspiciousMultiEmailSites.length}`);
  console.log(`Legacy subscriptions without site_id: ${report.legacyUserLinkedSubscriptionsRemaining}`);

  if (report.duplicateSitesByDomain.length) {
    console.log('\nDuplicate canonical-domain groups:');
    for (const group of report.duplicateSitesByDomain.slice(0, 20)) {
      console.log(`- ${group.key}: ${group.count} sites (${group.siteIds.join(', ')})`);
    }
  }

  if (report.suspiciousMultiEmailSites.length) {
    console.log('\nSuspicious multi-email sites:');
    for (const site of report.suspiciousMultiEmailSites.slice(0, 20)) {
      console.log(`- ${site.siteId} ${site.canonicalDomain || ''} -> ${site.emailCount} emails`);
    }
  }
}

main().catch((error) => {
  console.error('[audit-site-duplicates] failed:', error.message);
  process.exit(1);
});
