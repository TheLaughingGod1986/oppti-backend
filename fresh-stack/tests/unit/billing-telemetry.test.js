const {
  resolveCanonicalEvents,
  buildCanonicalProperties,
  calculateMrrDelta,
  normalizePlan
} = require('../../services/billingTelemetry');

describe('billingTelemetry', () => {
  test('maps subscription_create invoice to subscription_activated', () => {
    const events = resolveCanonicalEvents({
      stripeEventType: 'invoice.payment_succeeded',
      eventProperties: {
        billing_reason: 'subscription_create',
        plan: 'pro',
        purchase_type: 'new_purchase'
      }
    });

    expect(events).toEqual(['subscription_activated']);
  });

  test('maps subscription_cycle invoice to subscription_renewed', () => {
    const events = resolveCanonicalEvents({
      stripeEventType: 'invoice.payment_succeeded',
      eventProperties: {
        billing_reason: 'subscription_cycle',
        plan: 'pro'
      }
    });

    expect(events).toEqual(['subscription_renewed']);
  });

  test('maps recovered invoice payment to payment_recovered before subscription_cycle', () => {
    const events = resolveCanonicalEvents({
      stripeEventType: 'invoice.payment_succeeded',
      eventProperties: {
        billing_reason: 'subscription_cycle',
        plan: 'pro',
        payment_recovered: true
      }
    });

    expect(events).toEqual(['payment_recovered', 'subscription_renewed']);
  });

  test('maps recovered subscription_create invoice to payment_recovered and subscription_activated', () => {
    const events = resolveCanonicalEvents({
      stripeEventType: 'invoice.payment_succeeded',
      eventProperties: {
        billing_reason: 'subscription_create',
        plan: 'pro',
        payment_recovered: true
      }
    });

    expect(events).toEqual(['payment_recovered', 'subscription_activated']);
  });

  test('builds canonical billing properties with mrr delta', () => {
    const properties = buildCanonicalProperties({
      stripeEventId: 'evt_test',
      canonicalEvent: 'subscription_upgraded',
      eventProperties: {
        plan: 'pro',
        previous_plan: 'starter',
        billing_period: 'monthly',
        amount: 12.99,
        currency: 'gbp',
        stripe_customer_id: 'cus_123',
        stripe_subscription_id: 'sub_123',
        plugin_version: '4.6.114',
        site_install_id: 'site_hash_abc'
      }
    });

    expect(properties.customer_id).toBe('cus_123');
    expect(properties.subscription_id).toBe('sub_123');
    expect(properties.plan).toBe('pro');
    expect(properties.previous_plan).toBe('starter');
    expect(properties.mrr_delta).toBeGreaterThan(0);
    expect(properties.arr_delta).toBe(properties.mrr_delta * 12);
    expect(properties.event_source).toBe('stripe_webhook');
    expect(properties.telemetry_version).toBe('1');
    expect(properties.$insert_id).toBe('evt_test');
  });

  test('normalizes growth plan alias to pro', () => {
    expect(normalizePlan('growth')).toBe('pro');
  });

  test('calculates negative mrr delta on downgrade', () => {
    const delta = calculateMrrDelta({
      previousPlan: 'pro',
      plan: 'starter',
      billingInterval: 'monthly',
      amount: 4.99
    });

    expect(delta).toBeLessThan(0);
  });
});
