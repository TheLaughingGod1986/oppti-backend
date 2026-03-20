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
      reset_date: currentPeriodEnd ? new Date(currentPeriodEnd) : null,
      billing_anchor_date: currentPeriodEnd ? new Date(currentPeriodEnd) : new Date()
    })
    .eq('license_key', licenseKey);

  if (!error) {
    const { data: license } = await supabase
      .from('licenses')
      .select('email')
      .eq('license_key', licenseKey)
      .single();
    if (license?.email) {
      trackPlanUpgraded({ email: license.email, planName: planType }).catch(() => {});
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
      reset_date: currentPeriodEnd ? new Date(currentPeriodEnd) : null,
      billing_anchor_date: currentPeriodEnd ? new Date(currentPeriodEnd) : new Date()
    })
    .eq('license_key', licenseKey);

  if (!error) {
    const { data: license } = await supabase
      .from('licenses')
      .select('email')
      .eq('license_key', licenseKey)
      .single();
    if (license?.email) {
      trackPlanUpgraded({ email: license.email, planName: planType }).catch(() => {});
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

async function purchaseCredits(supabase, { licenseKey, credits, pricePaid, stripePaymentIntentId, stripeChargeId, expiresAt = null }) {
  const { data, error } = await supabase
    .from('credits')
    .insert({
      license_key: licenseKey,
      credits_purchased: credits,
      credits_remaining: credits,
      price_paid: pricePaid,
      stripe_payment_intent_id: stripePaymentIntentId,
      stripe_charge_id: stripeChargeId,
      expires_at: expiresAt,
      status: 'active'
    })
    .select()
    .single();
  return { data, error };
}

module.exports = {
  handleSubscriptionCreated,
  handleSubscriptionUpdated,
  handleSubscriptionDeleted,
  handlePaymentSucceeded,
  purchaseCredits
};
