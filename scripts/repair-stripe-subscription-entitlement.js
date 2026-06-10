#!/usr/bin/env node

const Stripe = require('stripe');
const {
  createSupabase,
  getArgValue,
  getPlanDefaults,
  hasFlag,
  normalizePlan
} = require('./_site-quota-utils');

function maskSecret(value) {
  if (!value) return null;
  const normalized = String(value);
  return normalized.length > 8 ? `${normalized.slice(0, 8)}...` : '[redacted]';
}

function getRequiredArg(flag) {
  const value = getArgValue(flag);
  if (!value) throw new Error(`Missing required argument: ${flag}`);
  return value;
}

function toIsoFromSeconds(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0
    ? new Date(parsed * 1000).toISOString()
    : null;
}

function inferPlanFromPrice(priceId, metadata = {}) {
  const metadataPlan = normalizePlan(metadata.plan || metadata.target_plan || null);
  if (metadataPlan && metadataPlan !== 'free') return metadataPlan;

  const configured = {
    pro: [
      process.env.STRIPE_PRICE_PRO,
      process.env.STRIPE_PRO_PRICE_ID,
      process.env.PRICE_ID_PRO
    ],
    agency: [
      process.env.STRIPE_PRICE_AGENCY,
      process.env.STRIPE_AGENCY_PRICE_ID,
      process.env.PRICE_ID_AGENCY
    ],
    credits: [
      process.env.STRIPE_PRICE_CREDITS,
      process.env.STRIPE_CREDITS_PRICE_ID,
      process.env.PRICE_ID_CREDITS
    ]
  };

  for (const [plan, priceIds] of Object.entries(configured)) {
    if (priceIds.filter(Boolean).includes(priceId)) return plan;
  }

  return 'pro';
}

function inferBillingInterval(subscription, price) {
  return price?.recurring?.interval
    || subscription.items?.data?.[0]?.price?.recurring?.interval
    || 'month';
}

function canonicalDomainFromUrl(siteUrl) {
  if (!siteUrl) return null;
  try {
    return new URL(siteUrl).hostname.replace(/^www\./i, '').toLowerCase();
  } catch (_error) {
    return null;
  }
}

async function findLicense(supabase, licenseKey) {
  const { data, error } = await supabase
    .from('licenses')
    .select('id, email, license_key, plan, status, stripe_customer_id, stripe_subscription_id')
    .eq('license_key', licenseKey)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

async function findRepairSite(supabase, { licenseKey, siteId, siteUrl, canonicalDomain }) {
  if (siteId) {
    const { data, error } = await supabase
      .from('sites')
      .select('id, license_key, site_hash, site_url, canonical_domain')
      .eq('id', siteId)
      .maybeSingle();
    if (error) throw error;
    if (data) return data;
  }

  const { data, error } = await supabase
    .from('sites')
    .select('id, license_key, site_hash, site_url, canonical_domain')
    .eq('license_key', licenseKey);
  if (error) throw error;

  const sites = Array.isArray(data) ? data : [];
  if (canonicalDomain) {
    const domainMatch = sites.find((site) => site.canonical_domain === canonicalDomain);
    if (domainMatch) return domainMatch;
  }
  if (siteUrl) {
    const urlMatch = sites.find((site) => site.site_url === siteUrl);
    if (urlMatch) return urlMatch;
  }
  return sites.length === 1 ? sites[0] : null;
}

async function maybeWrite(label, write, action, report) {
  if (!write) {
    report.planned_writes.push(label);
    return null;
  }
  const result = await action();
  report.executed_writes.push(label);
  return result;
}

async function findCurrentSiteQuota(supabase, siteId, periodStart, periodEnd) {
  const { data, error } = await supabase
    .from('site_quotas')
    .select('id, site_id, quota_period_start, quota_period_end, monthly_included_credits, used_credits, remaining_credits')
    .eq('site_id', siteId)
    .eq('quota_period_start', periodStart)
    .eq('quota_period_end', periodEnd)
    .maybeSingle();
  if (error && error.code !== 'PGRST116') throw error;
  return data || null;
}

async function main() {
  const write = hasFlag('--write');
  const subscriptionId = getRequiredArg('--subscription-id');
  const customerIdArg = getArgValue('--customer-id');
  const licenseKey = getRequiredArg('--license-key');
  const siteUrl = getArgValue('--site-url');
  const siteIdArg = getArgValue('--site-id');

  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) throw new Error('Missing required environment variable: STRIPE_SECRET_KEY');

  const stripe = new Stripe(stripeKey);
  const supabase = createSupabase();
  const subscription = await stripe.subscriptions.retrieve(subscriptionId, {
    expand: ['items.data.price']
  });
  const price = subscription.items?.data?.[0]?.price || null;
  const plan = inferPlanFromPrice(price?.id || null, subscription.metadata || {});
  const customerId = customerIdArg || (typeof subscription.customer === 'string'
    ? subscription.customer
    : subscription.customer?.id);
  const canonicalDomain = canonicalDomainFromUrl(siteUrl || subscription.metadata?.site_url || null);
  const license = await findLicense(supabase, licenseKey);
  const site = await findRepairSite(supabase, {
    licenseKey,
    siteId: siteIdArg || subscription.metadata?.site_id || null,
    siteUrl: siteUrl || subscription.metadata?.site_url || null,
    canonicalDomain
  });

  const report = {
    dry_run: !write,
    subscription_id: subscription.id,
    customer_id: customerId || null,
    license_key_prefix: maskSecret(licenseKey),
    license_found: Boolean(license),
    site_id: site?.id || null,
    site_hash: site?.site_hash || null,
    site_found: Boolean(site),
    plan,
    status: subscription.status,
    price_id: price?.id || null,
    planned_writes: [],
    executed_writes: [],
    warnings: []
  };

  if (!license) report.warnings.push('license_not_found');
  if (!site) report.warnings.push('site_not_found_or_ambiguous');
  if (!site?.id) {
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = 2;
    return;
  }

  const periodStart = toIsoFromSeconds(subscription.current_period_start);
  const periodEnd = toIsoFromSeconds(subscription.current_period_end);
  const billingInterval = inferBillingInterval(subscription, price);
  const planDefaults = getPlanDefaults(plan);

  const siteSubscriptionPayload = {
    site_id: site.id,
    plan_id: plan,
    stripe_customer_id: customerId || null,
    stripe_subscription_id: subscription.id,
    status: subscription.status || 'active',
    billing_interval: billingInterval,
    current_period_start: periodStart,
    current_period_end: periodEnd,
    cancel_at_period_end: Boolean(subscription.cancel_at_period_end)
  };

  await maybeWrite('site_subscriptions.upsert', write, async () => {
    const { error } = await supabase
      .from('site_subscriptions')
      .upsert(siteSubscriptionPayload, { onConflict: 'stripe_subscription_id' });
    if (error) throw error;
  }, report);

  await maybeWrite('licenses.update_stripe_pointers', write, async () => {
    const { error } = await supabase
      .from('licenses')
      .update({
        plan,
        status: subscription.status || 'active',
        stripe_customer_id: customerId || null,
        stripe_subscription_id: subscription.id
      })
      .eq('license_key', licenseKey);
    if (error) throw error;
  }, report);

  const currentSiteQuota = await findCurrentSiteQuota(supabase, site.id, periodStart, periodEnd);
  if (currentSiteQuota) {
    report.planned_writes.push('site_quotas.preserve_existing_current_period');
    report.current_site_quota = {
      id: currentSiteQuota.id,
      monthly_included_credits: currentSiteQuota.monthly_included_credits,
      used_credits: currentSiteQuota.used_credits,
      remaining_credits: currentSiteQuota.remaining_credits
    };
  } else {
    await maybeWrite('site_quotas.insert_current_period', write, async () => {
      const { error } = await supabase
        .from('site_quotas')
        .insert({
          site_id: site.id,
          quota_period_start: periodStart,
          quota_period_end: periodEnd,
          monthly_included_credits: planDefaults.monthlyIncludedCredits,
          purchased_credits_balance: 0,
          bonus_credits_balance: 0,
          used_credits: 0,
          remaining_credits: planDefaults.monthlyIncludedCredits,
          reset_source: 'stripe_subscription_repair'
        });
      if (error) throw error;
    }, report);
  }

  await maybeWrite('subscriptions.upsert_legacy_best_effort', write, async () => {
    const { error } = await supabase
      .from('subscriptions')
      .upsert({
        license_key: licenseKey,
        site_id: site.id,
        plan,
        status: subscription.status || 'active',
        stripe_customer_id: customerId || null,
        stripe_subscription_id: subscription.id,
        current_period_start: periodStart,
        current_period_end: periodEnd,
        cancel_at_period_end: Boolean(subscription.cancel_at_period_end)
      }, { onConflict: 'stripe_subscription_id' });
    if (error && error.code !== '42P01') throw error;
    if (error?.code === '42P01') report.warnings.push('legacy_subscriptions_table_missing');
  }, report);

  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error('[repair-stripe-subscription-entitlement] failed:', error.message);
  process.exit(1);
});
