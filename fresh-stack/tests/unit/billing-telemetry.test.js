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
  emitIdentityLinks,
  emitCanonicalBillingEvents,
  LEGACY_PAYMENT_SUCCEEDED_KEYS
} = require('../../services/billingTelemetry');
const { identifyServerUser, aliasServerUser, captureServerEvent } = require('../../lib/posthog');

describe('legacy payment_succeeded allowed list', () => {
  beforeEach(() => jest.clearAllMocks());

  const pii = {
    email: 'qa-person@example.invalid',
    license_key: 'QA-FAKE-LICENSE-KEY-0001',
    name: 'Jane Customer',
    customer_name: 'Jane Customer',
    address: '1 High Street',
    referrer: 'https://shop.customer-brand.co.uk/wp-admin/admin.php?page=x',
    landing_page: 'https://shop.customer-brand.co.uk/pricing',
    source_page: 'https://shop.customer-brand.co.uk/wp-admin/upload.php',
    site_url: 'https://shop.customer-brand.co.uk',
    meta: { site_url: 'https://shop.customer-brand.co.uk' }
  };

  test('sends only the allowed keys; email, licence key, names, addresses and URLs are stripped', async () => {
    await emitCanonicalBillingEvents({
      stripeEventId: 'evt_pii_1',
      stripeEventType: 'checkout.session.completed',
      distinctId: 'acct_9',
      includeLegacyPaymentSucceeded: true,
      eventProperties: {
        ...pii,
        amount: 19.99,
        currency: 'gbp',
        plan: 'credits',
        price_id: 'price_credits',
        billing_period: 'one_time',
        account_id: 'acct_9',
        site_install_id: 'install_abcdef1234567890',
        checkout_session_id: 'cs_test_9',
        livemode: false,
        stripe_customer_id: 'cus_9',
        purchase_type: 'credit_top_up',
        payment_mode: 'payment'
      },
      metadata: { plugin_id: 'alt_text', ...pii }
    });

    const call = captureServerEvent.mock.calls.find(([args]) => args.event === 'payment_succeeded');
    expect(call).toBeTruthy();
    const props = call[0].properties;
    expect(props).toEqual({
      amount: 19.99,
      currency: 'gbp',
      plan: 'credits',
      price_id: 'price_credits',
      plugin: 'alt_text',
      billing_interval: 'one_time',
      account_id: 'acct_9',
      site_install_id: 'install_abcdef1234567890',
      checkout_session_id: 'cs_test_9',
      is_test: true,
      livemode: false,
      $insert_id: 'evt_pii_1'
    });
    for (const key of Object.keys(props)) {
      expect([...LEGACY_PAYMENT_SUCCEEDED_KEYS, '$insert_id']).toContain(key);
    }
    expect(JSON.stringify(call[0])).not.toMatch(/example\.invalid|QA-FAKE-LICENSE-KEY|Jane|High Street|customer-brand/);
  });

  test('live payment is not test traffic', async () => {
    await emitCanonicalBillingEvents({
      stripeEventId: 'evt_live_1',
      stripeEventType: 'invoice.payment_succeeded',
      distinctId: 'acct_9',
      includeLegacyPaymentSucceeded: true,
      eventProperties: { amount: 14.99, currency: 'usd', plan: 'pro', livemode: true, email: pii.email, license_key: pii.license_key }
    });
    const [args] = captureServerEvent.mock.calls.find(([a]) => a.event === 'payment_succeeded');
    expect(args.properties).toEqual(expect.objectContaining({ is_test: false, livemode: true }));
    expect(args.properties).not.toHaveProperty('email');
    expect(args.properties).not.toHaveProperty('license_key');
  });
});

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
