#!/usr/bin/env node

const {
  createSupabase,
  currentMonthlyWindow,
  getPlanDefaults,
  hasFlag,
  normalizePlan
} = require('./_site-quota-utils');

async function main() {
  const supabase = createSupabase();
  const write = hasFlag('--write');
  const trialCredits = Number(process.env.SITE_TRIAL_CREDITS || process.env.TRIAL_LIMIT || 3);
  const window = currentMonthlyWindow();

  const { data: sites, error: siteError } = await supabase
    .from('sites')
    .select('id, license_key, site_hash, owner_user_id, merged_into_site_id, created_at')
    .is('merged_into_site_id', null);
  if (siteError) throw siteError;

  const { data: licenses, error: licenseError } = await supabase
    .from('licenses')
    .select('id, license_key, plan, billing_cycle, stripe_customer_id, stripe_subscription_id');
  if (licenseError) throw licenseError;
  const licenseByKey = new Map((licenses || []).map((license) => [license.license_key, license]));

  const { data: siteSubscriptions, error: siteSubscriptionError } = await supabase
    .from('site_subscriptions')
    .select('site_id, plan_id, billing_interval, current_period_start, current_period_end, stripe_customer_id, stripe_subscription_id, status');
  if (siteSubscriptionError && siteSubscriptionError.code !== '42P01') throw siteSubscriptionError;
  const subscriptionBySiteId = new Map((siteSubscriptions || []).map((subscription) => [subscription.site_id, subscription]));

  const { data: legacySummaries, error: summaryError } = await supabase
    .from('quota_summaries')
    .select('license_key, period_start, period_end, total_credits_used')
    .eq('period_start', window.start);
  if (summaryError) throw summaryError;
  const summaryByLicenseKey = new Map((legacySummaries || []).map((summary) => [summary.license_key, summary]));

  const { data: usageLogs, error: usageError } = await supabase
    .from('usage_logs')
    .select('site_hash, license_key, credits_used, created_at')
    .gte('created_at', window.start)
    .lt('created_at', window.end);
  if (usageError) throw usageError;

  const usageBySiteHash = new Map();
  for (const row of usageLogs || []) {
    const key = row.site_hash || row.license_key;
    if (!key) continue;
    usageBySiteHash.set(key, (usageBySiteHash.get(key) || 0) + Number(row.credits_used || 0));
  }

  const { data: trialUsage, error: trialError } = await supabase
    .from('trial_usage')
    .select('site_hash');
  if (trialError && trialError.code !== '42P01') throw trialError;
  const trialCounts = new Map();
  for (const row of trialUsage || []) {
    if (!row.site_hash) continue;
    trialCounts.set(row.site_hash, (trialCounts.get(row.site_hash) || 0) + 1);
  }

  const summary = {
    quotasPrepared: 0,
    quotasUpserted: 0,
    trialsPrepared: 0,
    trialsUpserted: 0
  };

  for (const site of sites || []) {
    const license = site.license_key ? licenseByKey.get(site.license_key) : null;
    const subscription = subscriptionBySiteId.get(site.id) || null;
    const effectivePlan = normalizePlan(subscription?.plan_id || license?.plan || 'free');
    const defaults = getPlanDefaults(effectivePlan);
    const summaryRow = site.license_key ? summaryByLicenseKey.get(site.license_key) : null;
    const usedCredits = usageBySiteHash.get(site.site_hash) || summaryRow?.total_credits_used || 0;
    const billingInterval = subscription?.billing_interval || defaults.billingInterval;
    const quotaRecord = {
      site_id: site.id,
      quota_period_start: subscription?.current_period_start || window.start,
      quota_period_end: subscription?.current_period_end || window.end,
      monthly_included_credits: defaults.monthlyIncludedCredits,
      purchased_credits_balance: effectivePlan === 'credits' ? 0 : 0,
      bonus_credits_balance: 0,
      used_credits: usedCredits,
      remaining_credits: Math.max(defaults.monthlyIncludedCredits - usedCredits, 0),
      reset_source: subscription ? 'subscription_period' : 'monthly_rollover'
    };

    summary.quotasPrepared += 1;
    if (write) {
      const { error } = await supabase
        .from('site_quotas')
        .upsert(quotaRecord, { onConflict: 'site_id,quota_period_start,quota_period_end' });
      if (error) throw error;
      summary.quotasUpserted += 1;
    }

    const usedTrialCredits = Math.min(trialCounts.get(site.site_hash) || 0, trialCredits);
    if (usedTrialCredits === 0) continue;

    const trialRecord = {
      site_id: site.id,
      trial_type: 'initial',
      total_trial_credits: trialCredits,
      used_trial_credits: usedTrialCredits,
      status: usedTrialCredits >= trialCredits ? 'exhausted' : 'active',
      started_at: site.created_at || window.start,
      exhausted_at: usedTrialCredits >= trialCredits ? new Date().toISOString() : null
    };

    summary.trialsPrepared += 1;
    if (write) {
      const { data: existingTrial, error: existingTrialError } = await supabase
        .from('site_trials')
        .select('id')
        .eq('site_id', site.id)
        .eq('trial_type', 'initial')
        .eq('status', 'active')
        .maybeSingle();
      if (existingTrialError && existingTrialError.code !== '42P01') throw existingTrialError;

      if (existingTrial?.id) {
        const { error } = await supabase
          .from('site_trials')
          .update(trialRecord)
          .eq('id', existingTrial.id);
        if (error) throw error;
      } else {
        const { error } = await supabase
          .from('site_trials')
          .insert(trialRecord);
        if (error) throw error;
      }
      summary.trialsUpserted += 1;
    }
  }

  console.log(JSON.stringify({ dryRun: !write, window, summary }, null, 2));
}

main().catch((error) => {
  console.error('[migrate-user-quotas-to-site-quotas] failed:', error.message);
  process.exit(1);
});
