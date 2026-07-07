/**
 * Canonical SaaS billing telemetry for PostHog.
 * Emits verified Stripe-webhook events only — never frontend assumptions.
 */

const logger = require('../lib/logger');
const { captureServerEvent, identifyServerUser, aliasServerUser } = require('../lib/posthog');

const TELEMETRY_VERSION = '1';
const PAYMENT_PROVIDER = 'stripe';
const EVENT_SOURCE = 'stripe_webhook';

const PLAN_MONTHLY_MRR = {
  free: 0,
  starter: 4.99,
  pro: 12.99,
  agency: 39.99,
  credits: 0,
  trial: 0,
  unknown: 0
};

const PLAN_TIER = {
  free: 0,
  starter: 1,
  pro: 2,
  agency: 3,
  credits: 0,
  trial: 0,
  unknown: 0
};

function roundMoney(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.round(value * 100) / 100;
}

function normalizePlan(plan) {
  if (plan === undefined || plan === null) return 'unknown';
  const normalized = String(plan).trim().toLowerCase();
  if (!normalized) return 'unknown';
  if (normalized === 'growth') return 'pro';
  return normalized;
}

function normalizeBillingInterval(value) {
  if (!value) return 'monthly';
  const normalized = String(value).trim().toLowerCase();
  if (normalized === 'year' || normalized === 'yearly' || normalized === 'annual') return 'yearly';
  if (normalized === 'one_time' || normalized === 'one-time') return 'one_time';
  return 'monthly';
}

function resolveMonthlyMrr(plan, billingInterval, amount) {
  const normalizedPlan = normalizePlan(plan);
  if (normalizedPlan === 'credits' || normalizedPlan === 'free') {
    return 0;
  }

  if (typeof amount === 'number' && amount > 0) {
    const interval = normalizeBillingInterval(billingInterval);
    if (interval === 'yearly') {
      return roundMoney(amount / 12);
    }
    return roundMoney(amount);
  }

  return roundMoney(PLAN_MONTHLY_MRR[normalizedPlan] ?? 0);
}

function calculateMrrDelta({ previousPlan, plan, billingInterval, amount }) {
  const previousMrr = resolveMonthlyMrr(previousPlan, billingInterval, null);
  const nextMrr = resolveMonthlyMrr(plan, billingInterval, amount);
  return roundMoney(nextMrr - previousMrr);
}

function calculateArrDelta(mrrDelta) {
  return roundMoney(mrrDelta * 12);
}

function inferAcquisitionChannel(attribution = {}) {
  if (attribution.acquisition_channel) return attribution.acquisition_channel;
  if (attribution.utm_source) return String(attribution.utm_source).toLowerCase();
  if (attribution.referrer) return 'referral';
  return null;
}

function resolveAttributionFromMetadata(metadata = {}) {
  const read = (keys) => {
    for (const key of keys) {
      const value = metadata[key];
      if (typeof value === 'string' && value.trim()) {
        return value.trim();
      }
    }
    return null;
  };

  return {
    utm_source: read(['utm_source', 'utmSource']),
    utm_medium: read(['utm_medium', 'utmMedium']),
    utm_campaign: read(['utm_campaign', 'utmCampaign']),
    utm_content: read(['utm_content', 'utmContent']),
    utm_term: read(['utm_term', 'utmTerm']),
    referrer: read(['referrer', 'initial_referrer', 'initialReferrer']),
    landing_page: read(['landing_page', 'landingPage']),
    acquisition_channel: read(['acquisition_channel', 'acquisitionChannel', 'signup_source', 'signupSource'])
  };
}

function buildCanonicalProperties({
  eventProperties = {},
  metadata = {},
  site = null,
  account = null,
  stripeEventId,
  canonicalEvent
}) {
  const plan = normalizePlan(eventProperties.plan);
  const previousPlan = normalizePlan(
    eventProperties.previous_plan
    || eventProperties.current_plan
    || metadata.current_plan
    || metadata.currentPlan
    || account?.plan
    || 'free'
  );
  const billingInterval = normalizeBillingInterval(
    eventProperties.billing_interval
    || eventProperties.billing_period
    || metadata.billing_interval
    || metadata.billingInterval
    || account?.billing_cycle
  );
  const amount = typeof eventProperties.amount === 'number' ? eventProperties.amount : null;
  const mrrDelta = calculateMrrDelta({
    previousPlan,
    plan,
    billingInterval,
    amount
  });
  const attribution = {
    ...resolveAttributionFromMetadata(metadata),
    ...resolveAttributionFromMetadata(eventProperties)
  };

  const siteInstallId = eventProperties.site_install_id
    || metadata.site_install_id
    || metadata.siteInstallId
    || site?.site_hash
    || eventProperties.site_hash
    || null;

  let host = eventProperties.host || metadata.host || null;
  if (!host && (site?.site_url || metadata.site_url)) {
    try {
      host = new URL(site.site_url || metadata.site_url).hostname.toLowerCase();
    } catch (_error) {
      host = null;
    }
  }

  const properties = {
    customer_id: eventProperties.stripe_customer_id || null,
    subscription_id: eventProperties.stripe_subscription_id || null,
    plan,
    previous_plan: previousPlan,
    billing_interval: billingInterval,
    currency: eventProperties.currency || null,
    amount,
    mrr_delta: mrrDelta,
    arr_delta: calculateArrDelta(mrrDelta),
    trial_days: eventProperties.trial_days ?? metadata.trial_days ?? metadata.trialDays ?? null,
    coupon: eventProperties.coupon || metadata.coupon || metadata.promotion_code || null,
    payment_provider: PAYMENT_PROVIDER,
    country: eventProperties.country || metadata.country || null,
    plugin_version: eventProperties.plugin_version || metadata.plugin_version || metadata.pluginVersion || null,
    site_install_id: siteInstallId,
    host,
    telemetry_version: TELEMETRY_VERSION,
    event_source: EVENT_SOURCE,
    expansion_mrr: mrrDelta > 0 ? mrrDelta : 0,
    contraction_mrr: mrrDelta < 0 ? Math.abs(mrrDelta) : 0,
    refund_value: canonicalEvent === 'refund_processed' ? amount : 0,
    lifetime_revenue: eventProperties.lifetime_revenue ?? null,
    customer_lifetime_days: eventProperties.customer_lifetime_days ?? null,
    total_renewals: eventProperties.total_renewals ?? null,
    total_payments: eventProperties.total_payments ?? null,
    account_id: eventProperties.account_id || account?.id || null,
    user_id: eventProperties.user_id || account?.id || null,
    site_id: eventProperties.site_id || site?.id || null,
    site_hash: eventProperties.site_hash || site?.site_hash || null,
    license_key_present: Boolean(eventProperties.license_key_present || eventProperties.license_key),
    purchase_type: eventProperties.purchase_type || null,
    billing_reason: eventProperties.billing_reason || null,
    stripe_event_id: stripeEventId,
    stripe_event_type: eventProperties.stripe_event_type || null,
    $insert_id: stripeEventId,
    ...attribution,
    acquisition_channel: inferAcquisitionChannel(attribution),
    trigger_feature: eventProperties.trigger_feature || null,
    trigger_location: eventProperties.trigger_location || null,
    source_page: eventProperties.source_page || attribution.landing_page || null,
    target_plan: eventProperties.target_plan || null,
    identity_path: eventProperties.identity_path || null
  };

  return Object.fromEntries(
    Object.entries(properties).filter(([, value]) => value !== undefined)
  );
}

function resolveCanonicalEvents({
  stripeEventType,
  eventProperties = {},
  subscriptionStatus = null
}) {
  const purchaseType = eventProperties.purchase_type;
  const billingReason = eventProperties.billing_reason;
  const paymentMode = eventProperties.payment_mode;
  const previousPlan = normalizePlan(eventProperties.previous_plan || eventProperties.current_plan);
  const plan = normalizePlan(eventProperties.plan);
  const planTierDelta = (PLAN_TIER[plan] ?? 0) - (PLAN_TIER[previousPlan] ?? 0);

  if (stripeEventType === 'checkout.session.completed') {
    if (paymentMode === 'subscription') {
      return ['checkout_completed'];
    }
    if (paymentMode === 'payment') {
      return ['checkout_completed'];
    }
  }

  if (stripeEventType === 'invoice.payment_succeeded' || stripeEventType === 'invoice.paid') {
    const events = [];

    if (eventProperties.payment_recovered) {
      events.push('payment_recovered');
    }

    if (eventProperties.is_trial_conversion) {
      events.push('trial_converted', 'subscription_activated');
      return events;
    }
    if (billingReason === 'subscription_create') {
      if (subscriptionStatus === 'trialing') {
        events.push('trial_started');
      } else {
        events.push('subscription_activated');
      }
      return events;
    }
    if (billingReason === 'subscription_cycle') {
      events.push('subscription_renewed');
      return events;
    }
    if (billingReason === 'subscription_update') {
      if (purchaseType === 'upgrade' || planTierDelta > 0) {
        events.push('subscription_upgraded');
      } else if (planTierDelta < 0) {
        events.push('subscription_downgraded');
      } else {
        events.push('subscription_renewed');
      }
      return events;
    }
    if (!eventProperties.stripe_subscription_id) {
      return events;
    }
    events.push('subscription_activated');
    return events;
  }

  if (stripeEventType === 'customer.subscription.updated') {
    if (subscriptionStatus === 'trialing') {
      return ['trial_started'];
    }
    if (purchaseType === 'upgrade' || planTierDelta > 0) {
      return ['subscription_upgraded'];
    }
    if (planTierDelta < 0) {
      return ['subscription_downgraded'];
    }
    if (eventProperties.cancel_at_period_end) {
      return [];
    }
    return [];
  }

  if (stripeEventType === 'customer.subscription.deleted') {
    return ['subscription_cancelled'];
  }

  if (stripeEventType === 'customer.subscription.trial_will_end') {
    return ['trial_expired'];
  }

  if (stripeEventType === 'payment_intent.payment_failed') {
    return ['payment_failed'];
  }

  if (stripeEventType === 'invoice.payment_failed') {
    return ['payment_failed'];
  }

  if (stripeEventType === 'invoice.payment_action_required') {
    return ['payment_failed'];
  }

  if (stripeEventType === 'charge.refunded' || stripeEventType === 'refund.created') {
    return ['refund_processed'];
  }

  return [];
}

async function emitIdentityLinks({ distinctId, eventProperties = {}, account = null }) {
  const accountId = eventProperties.account_id || account?.id || null;
  const siteInstallId = eventProperties.site_install_id || eventProperties.site_hash || null;

  if (accountId && siteInstallId && accountId !== siteInstallId) {
    await aliasServerUser({
      distinctId: accountId,
      alias: siteInstallId
    });
  }

  if (accountId && (account?.email || eventProperties.email)) {
    await identifyServerUser({
      distinctId: accountId,
      properties: {
        email: account?.email || eventProperties.email || null,
        stripe_customer_id: eventProperties.stripe_customer_id || null,
        stripe_subscription_id: eventProperties.stripe_subscription_id || null,
        plan: eventProperties.plan || account?.plan || null,
        site_install_id: siteInstallId
      }
    });
  }
}

async function emitCanonicalBillingEvents({
  stripeEventId,
  stripeEventType,
  distinctId,
  eventProperties = {},
  metadata = {},
  site = null,
  account = null,
  subscriptionStatus = null,
  includeLegacyPaymentSucceeded = false
}) {
  if (!distinctId || !stripeEventId) {
    return { emitted: [], skipped: true };
  }

  const canonicalEvents = resolveCanonicalEvents({
    stripeEventType,
    eventProperties,
    subscriptionStatus
  });

  const emitted = [];

  for (const canonicalEvent of canonicalEvents) {
    const properties = buildCanonicalProperties({
      eventProperties,
      metadata,
      site,
      account,
      stripeEventId,
      canonicalEvent
    });

    const result = await captureServerEvent({
      event: canonicalEvent,
      distinctId,
      properties
    });

    emitted.push({
      event: canonicalEvent,
      ok: Boolean(result.ok),
      skipped: Boolean(result.skipped),
      status: result.status || null
    });

    if (result.ok) {
      logger.info('[billing] PostHog canonical billing event captured', {
        stripeEventId,
        stripeEventType,
        canonicalEvent,
        distinctId
      });
    } else if (!result.skipped) {
      logger.warn('[billing] PostHog canonical billing event failed', {
        stripeEventId,
        stripeEventType,
        canonicalEvent,
        distinctId,
        status: result.status || null,
        error: result.error?.message || null
      });
    }
  }

  if (includeLegacyPaymentSucceeded) {
    const legacyResult = await captureServerEvent({
      event: 'payment_succeeded',
      distinctId,
      properties: {
        ...eventProperties,
        stripe_event_id: stripeEventId,
        $insert_id: stripeEventId,
        telemetry_version: TELEMETRY_VERSION,
        event_source: EVENT_SOURCE
      }
    });
    emitted.push({
      event: 'payment_succeeded',
      ok: Boolean(legacyResult.ok),
      skipped: Boolean(legacyResult.skipped),
      status: legacyResult.status || null
    });
  }

  await emitIdentityLinks({ distinctId, eventProperties, account });

  return { emitted, skipped: false };
}

async function emitPaymentFailedEvent({
  stripeEventId,
  distinctId,
  eventProperties = {},
  metadata = {},
  site = null,
  account = null
}) {
  return emitCanonicalBillingEvents({
    stripeEventId,
    stripeEventType: 'payment_intent.payment_failed',
    distinctId,
    eventProperties,
    metadata,
    site,
    account
  });
}

module.exports = {
  TELEMETRY_VERSION,
  EVENT_SOURCE,
  normalizePlan,
  normalizeBillingInterval,
  resolveMonthlyMrr,
  calculateMrrDelta,
  calculateArrDelta,
  resolveAttributionFromMetadata,
  buildCanonicalProperties,
  resolveCanonicalEvents,
  emitCanonicalBillingEvents,
  emitPaymentFailedEvent
};
