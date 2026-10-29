jest.mock('../../lib/posthog', () => ({
  captureServerEvent: jest.fn().mockResolvedValue({ ok: true }),
  identifyServerUser: jest.fn().mockResolvedValue({ ok: true }),
  aliasServerUser: jest.fn().mockResolvedValue({ ok: true })
}));

const {
  resolveCanonicalEvents,
  buildCanonicalProperties,
  calculateMrrDelta,
  normalizePlan,
  emitIdentityLinks
} = require('../../services/billingTelemetry');
const { identifyServerUser, aliasServerUser } = require('../../lib/posthog');

describe('billingTelemetry identity links', () => {
  beforeEach(() => jest.clearAllMocks());

  test('identify keeps the account id and site install id but sends no email or licence key', async () => {
    await emitIdentityLinks({
      distinctId: 'acct_1',
      eventProperties: {
        account_id: 'acct_1',
        site_install_id: 'install_abcdef1234567890',
        email: 'owner@customer-brand.co.uk',
        license_key: 'lic_secret_1',
        stripe_customer_id: 'cus_1',
        plan: 'pro'
      },
      account: { id: 'acct_1', email: 'owner@customer-brand.co.uk', license_key: 'lic_secret_1', plan: 'pro' }
    });

    expect(aliasServerUser).toHaveBeenCalledWith({ distinctId: 'acct_1', alias: 'install_abcdef1234567890' });
    expect(identifyServerUser).toHaveBeenCalledTimes(1);
    const [args] = identifyServerUser.mock.calls[0];
    expect(args.distinctId).toBe('acct_1');
    expect(args.properties).toEqual(expect.objectContaining({ site_install_id: 'install_abcdef1234567890', plan: 'pro' }));
    expect(args.properties).not.toHaveProperty('email');
    expect(args.properties).not.toHaveProperty('license_key');
    expect(JSON.stringify(args)).not.toMatch(/customer-brand|lic_secret_1/);
  });

  test('identify still runs for an account with no email on file', async () => {
    await emitIdentityLinks({ distinctId: 'acct_2', eventProperties: { account_id: 'acct_2' }, account: { id: 'acct_2' } });
    expect(identifyServerUser).toHaveBeenCalledWith(expect.objectContaining({ distinctId: 'acct_2' }));
  });
});

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
