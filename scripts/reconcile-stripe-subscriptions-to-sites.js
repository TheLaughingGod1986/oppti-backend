#!/usr/bin/env node

const {
  createSupabase,
  hasFlag,
  inferLegacyBillingInterval,
  normalizePlan
} = require('./_site-quota-utils');

async function findCanonicalSiteForSubscription(supabase, subscription, sitesByLicenseKey) {
  if (subscription.site_id) {
    return subscription.site_id;
  }

  const licenseSites = sitesByLicenseKey.get(subscription.license_key) || [];
  if (licenseSites.length === 1) {
    return licenseSites[0].id;
  }

  if (licenseSites.length > 1) {
    return null;
  }

  const { data: existingSiteSubscriptions, error } = await supabase
    .from('site_subscriptions')
    .select('site_id')
    .eq('stripe_subscription_id', subscription.stripe_subscription_id)
    .limit(1);

  if (error && error.code !== '42P01') throw error;
  return Array.isArray(existingSiteSubscriptions) && existingSiteSubscriptions.length
    ? existingSiteSubscriptions[0].site_id
    : null;
}

async function main() {
  const supabase = createSupabase();
  const write = hasFlag('--write');

  const { data: sites, error: siteError } = await supabase
    .from('sites')
    .select('id, license_key, merged_into_site_id')
    .is('merged_into_site_id', null);
  if (siteError) throw siteError;

  const { data: subscriptions, error: subscriptionError } = await supabase
    .from('subscriptions')
    .select('id, license_key, site_id, plan, status, stripe_customer_id, stripe_subscription_id, current_period_start, current_period_end, cancel_at_period_end')
    .in('status', ['active', 'trialing', 'past_due', 'cancelled']);
  if (subscriptionError && subscriptionError.code !== '42P01') throw subscriptionError;

  const sitesByLicenseKey = new Map();
  for (const site of sites || []) {
    if (!site.license_key) continue;
    if (!sitesByLicenseKey.has(site.license_key)) sitesByLicenseKey.set(site.license_key, []);
    sitesByLicenseKey.get(site.license_key).push(site);
  }

  const report = {
    reconciled: 0,
    unmapped: []
  };

  for (const subscription of subscriptions || []) {
    const siteId = await findCanonicalSiteForSubscription(supabase, subscription, sitesByLicenseKey);
    if (!siteId) {
      report.unmapped.push({
        id: subscription.id,
        license_key: subscription.license_key,
        stripe_subscription_id: subscription.stripe_subscription_id,
        status: subscription.status
      });
      continue;
    }

    const payload = {
      site_id: siteId,
      plan_id: normalizePlan(subscription.plan),
      stripe_customer_id: subscription.stripe_customer_id || null,
      stripe_subscription_id: subscription.stripe_subscription_id || null,
      status: subscription.status || 'active',
      billing_interval: inferLegacyBillingInterval(subscription),
      current_period_start: subscription.current_period_start || null,
      current_period_end: subscription.current_period_end || null,
      cancel_at_period_end: Boolean(subscription.cancel_at_period_end)
    };

    report.reconciled += 1;
    if (!write) continue;

    const { error: upsertError } = await supabase
      .from('site_subscriptions')
      .upsert(payload, { onConflict: 'stripe_subscription_id' });
    if (upsertError) throw upsertError;

    const { error: legacyUpdateError } = await supabase
      .from('subscriptions')
      .update({ site_id: siteId })
      .eq('id', subscription.id);
    if (legacyUpdateError) throw legacyUpdateError;
  }

  console.log(JSON.stringify({ dryRun: !write, report }, null, 2));
}

main().catch((error) => {
  console.error('[reconcile-stripe-subscriptions-to-sites] failed:', error.message);
  process.exit(1);
});
