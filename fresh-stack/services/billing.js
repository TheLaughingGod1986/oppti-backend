/**
 * Billing service (Stripe hooks + credit purchases).
 * Stripe client should be injected to ease testing.
 */

const { trackPlanUpgraded } = require('../../src/services/loops');

async function handleSubscriptionCreated(supabase, { licenseKey, stripeCustomerId, stripeSubscriptionId, planType, currentPeriodEnd }) {
  const { error } = await supabase
    .from('licenses')
    .update({
      plan: planType,
      stripe_customer_id: stripeCustomerId,
      stripe_subscription_id: stripeSubscriptionId,
      status: 'active',
      billing_anchor_date: currentPeriodEnd ? new Date(currentPeriodEnd) : new Date()
    })
    .eq('license_key', licenseKey);

  if (!error) {
    const { data: license } = await supabase
      .from('licenses')
      .select('id, email')
      .eq('license_key', licenseKey)
      .single();
    if (license?.email) {
      trackPlanUpgraded({ email: license.email, userId: license.id, planName: planType }).catch(() => {});
    }
  }

  return { error };
}

async function handleSubscriptionUpdated(supabase, { licenseKey, planType, currentPeriodEnd, status }) {
  const { error } = await supabase
    .from('licenses')
    .update({
      plan: planType,
      status: status || 'active',
      billing_anchor_date: currentPeriodEnd ? new Date(currentPeriodEnd) : new Date()
    })
    .eq('license_key', licenseKey);

  if (!error) {
    const { data: license } = await supabase
      .from('licenses')
      .select('id, email')
      .eq('license_key', licenseKey)
      .single();
    if (license?.email) {
      trackPlanUpgraded({ email: license.email, userId: license.id, planName: planType }).catch(() => {});
    }
  }

  return { error };
}

async function handleSubscriptionDeleted(supabase, { licenseKey }) {
  const { error } = await supabase
    .from('licenses')
    .update({ status: 'cancelled' })
    .eq('license_key', licenseKey);
  return { error };
}

async function handlePaymentSucceeded(supabase, { licenseKey, billingAnchorDate }) {
  const anchor = billingAnchorDate ? new Date(billingAnchorDate) : new Date();
  const { error } = await supabase
    .from('licenses')
    .update({
      billing_anchor_date: anchor,
      billing_day_of_month: anchor.getUTCDate()
    })
    .eq('license_key', licenseKey);
  return { error };
}

module.exports = {
  handleSubscriptionCreated,
  handleSubscriptionUpdated,
  handleSubscriptionDeleted,
  handlePaymentSucceeded,
};
