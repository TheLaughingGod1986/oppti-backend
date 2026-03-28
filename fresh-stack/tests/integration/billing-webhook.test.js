const express = require('express');
const request = require('supertest');

jest.mock('../../lib/stripe', () => ({
  verifyWebhookSignature: jest.fn()
}));

jest.mock('../../lib/posthog', () => ({
  captureServerEvent: jest.fn().mockResolvedValue({ ok: true, status: 200 }),
  identifyServerUser: jest.fn().mockResolvedValue({ ok: true, status: 200 })
}));

const { verifyWebhookSignature } = require('../../lib/stripe');
const { captureServerEvent, identifyServerUser } = require('../../lib/posthog');
const { createBillingWebhookHandler } = require('../../routes/billing');

function normalizeAccount(account = {}) {
  return {
    plan: 'free',
    billing_cycle: 'monthly',
    stripe_customer_id: null,
    stripe_subscription_id: null,
    ...account
  };
}

function normalizeSite(site = {}) {
  return {
    id: site.id || `site_${site.site_hash || 'unknown'}`,
    license_key: null,
    ...site
  };
}

function createSupabaseMock({ accounts = [], sites = [] } = {}) {
  const updates = [];
  const accountRows = accounts.map((account) => normalizeAccount(account));
  const siteRows = sites.map((site) => normalizeSite(site));

  const findAccount = (column, value) => accountRows.find((row) => row[column] === value) || null;
  const findSite = (column, value) => siteRows.find((row) => row[column] === value) || null;

  return {
    updates,
    from(table) {
      if (table === 'licenses') {
        return {
          select() {
            return {
              eq(column, value) {
                return {
                  maybeSingle: jest.fn().mockResolvedValue({
                    data: findAccount(column, value),
                    error: null
                  }),
                  single: jest.fn().mockResolvedValue({
                    data: findAccount(column, value),
                    error: null
                  })
                };
              }
            };
          },
          update(payload) {
            return {
              eq(column, value) {
                return {
                  select() {
                    return {
                      single: jest.fn().mockImplementation(async () => {
                        updates.push({ table, column, value, payload });
                        let existing = findAccount(column, value);
                        if (!existing) {
                          existing = normalizeAccount({ id: value });
                          accountRows.push(existing);
                        }

                        Object.assign(existing, payload);

                        return {
                          data: { ...existing },
                          error: null
                        };
                      })
                    };
                  }
                };
              }
            };
          }
        };
      }

      if (table === 'sites') {
        return {
          select() {
            return {
              eq(column, value) {
                return {
                  maybeSingle: jest.fn().mockResolvedValue({
                    data: findSite(column, value),
                    error: null
                  })
                };
              }
            };
          }
        };
      }

      throw new Error(`Unexpected table: ${table}`);
    }
  };
}

function createApp({ supabase = null, stripeClient = null, webhookSecret = 'test-webhook-secret', priceIds } = {}) {
  const app = express();
  app.post(
    '/billing/webhook',
    express.raw({ type: 'application/json' }),
    createBillingWebhookHandler({
      supabase,
      getStripe: () => stripeClient,
      webhookSecret,
      priceIds: priceIds || {
        pro: 'price_pro',
        agency: 'price_agency',
        credits: 'price_credits'
      }
    })
  );
  return app;
}

async function sendWebhook(app, eventId = 'evt_test') {
  return request(app)
    .post('/billing/webhook')
    .set('Stripe-Signature', 'sig_test')
    .set('Content-Type', 'application/json')
    .send(JSON.stringify({ id: eventId }));
}

describe('POST /billing/webhook', () => {
  const originalStripeSecretKey = process.env.STRIPE_SECRET_KEY;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.STRIPE_SECRET_KEY = 'sk_test_mock';
  });

  afterAll(() => {
    process.env.STRIPE_SECRET_KEY = originalStripeSecretKey;
  });

  test('rejects invalid webhook signatures', async () => {
    verifyWebhookSignature.mockImplementation(() => {
      throw new Error('bad signature');
    });

    const app = createApp();
    const res = await sendWebhook(app, 'evt_invalid');

    expect(res.status).toBe(400);
    expect(captureServerEvent).not.toHaveBeenCalled();
  });

  test('tracks one-time checkout.session.completed payments and persists stripe customer mappings', async () => {
    const stripeClient = {
      checkout: {
        sessions: {
          listLineItems: jest.fn().mockResolvedValue({
            data: [{ price: { id: 'price_credits', product: 'prod_credits' } }]
          })
        }
      }
    };

    const supabase = createSupabaseMock({
      accounts: [
        {
          id: 'account_123',
          email: 'buyer@example.com',
          license_key: 'lic_123',
          plan: 'free'
        }
      ]
    });

    verifyWebhookSignature.mockImplementation(({ payload }) => {
      expect(Buffer.isBuffer(payload)).toBe(true);
      return {
        id: 'evt_checkout_paid',
        type: 'checkout.session.completed',
        data: {
          object: {
            id: 'cs_test_123',
            mode: 'payment',
            payment_status: 'paid',
            amount_total: 1999,
            currency: 'gbp',
            customer: 'cus_123',
            customer_details: {
              email: 'buyer@example.com'
            },
            subscription: null,
            livemode: false,
            payment_link: 'plink_123',
            metadata: {}
          }
        }
      };
    });

    const app = createApp({ supabase, stripeClient });
    const res = await sendWebhook(app, 'evt_checkout_paid');

    expect(res.status).toBe(200);
    expect(stripeClient.checkout.sessions.listLineItems).toHaveBeenCalledWith('cs_test_123', { limit: 1 });
    expect(captureServerEvent).toHaveBeenCalledWith({
      event: 'payment_succeeded',
      distinctId: 'account_123',
      properties: expect.objectContaining({
        source: 'stripe_webhook',
        stripe_event_id: 'evt_checkout_paid',
        stripe_event_type: 'checkout.session.completed',
        amount: 19.99,
        amount_minor: 1999,
        revenue: 19.99,
        currency: 'gbp',
        plan: 'credits',
        price_id: 'price_credits',
        product_id: 'prod_credits',
        stripe_customer_id: 'cus_123',
        stripe_subscription_id: null,
        checkout_session_id: 'cs_test_123',
        invoice_id: null,
        payment_link_id: 'plink_123',
        site_id: null,
        site_hash: null,
        email: 'buyer@example.com',
        account_id: 'account_123',
        user_id: 'account_123',
        license_key: 'lic_123',
        license_key_present: true,
        livemode: false,
        payment_mode: 'payment',
        billing_reason: null,
        billing_period: 'one_time',
        purchase_type: 'one_time',
        is_trial_conversion: false,
        $insert_id: 'evt_checkout_paid'
      })
    });
    expect(supabase.updates).toEqual([
      {
        table: 'licenses',
        column: 'id',
        value: 'account_123',
        payload: { stripe_customer_id: 'cus_123' }
      }
    ]);
    expect(identifyServerUser).toHaveBeenCalledWith({
      distinctId: 'account_123',
      properties: {
        email: 'buyer@example.com',
        stripe_customer_id: 'cus_123',
        stripe_subscription_id: null,
        license_key: 'lic_123',
        plan: 'free'
      }
    });
  });

  test('uses metadata license_key as fallback distinct id before site and Stripe ids when no account is resolved', async () => {
    const supabase = createSupabaseMock({
      sites: [
        {
          id: 'site_internal_123',
          site_hash: 'site_hash_123'
        }
      ]
    });

    verifyWebhookSignature.mockReturnValue({
      id: 'evt_checkout_metadata',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_test_metadata',
          mode: 'payment',
          payment_status: 'paid',
          amount_total: 1100,
          currency: 'usd',
          customer: 'cus_meta',
          livemode: false,
          payment_link: 'plink_meta',
          metadata: {
            license_key: 'lic_meta',
            site_hash: 'site_hash_123',
            plan: 'credits'
          }
        }
      }
    });

    const app = createApp({ supabase });
    const res = await sendWebhook(app, 'evt_checkout_metadata');

    expect(res.status).toBe(200);
    expect(captureServerEvent).toHaveBeenCalledWith({
      event: 'payment_succeeded',
      distinctId: 'lic_meta',
      properties: expect.objectContaining({
        stripe_event_id: 'evt_checkout_metadata',
        license_key: 'lic_meta',
        license_key_present: true,
        site_id: 'site_internal_123',
        site_hash: 'site_hash_123',
        stripe_customer_id: 'cus_meta',
        account_id: null,
        user_id: null,
        plan: 'credits',
        purchase_type: 'one_time',
        billing_period: 'one_time'
      })
    });
    expect(identifyServerUser).not.toHaveBeenCalled();
    expect(supabase.updates).toEqual([]);
  });

  test('uses internal site id as fallback distinct id when only a site mapping exists', async () => {
    const supabase = createSupabaseMock({
      sites: [
        {
          id: 'site_internal_only',
          site_hash: 'site_hash_only'
        }
      ]
    });

    verifyWebhookSignature.mockReturnValue({
      id: 'evt_checkout_site_only',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_site_only',
          mode: 'payment',
          payment_status: 'paid',
          amount_total: 500,
          currency: 'usd',
          customer: 'cus_site_only',
          livemode: false,
          metadata: {
            site_id: 'site_internal_only'
          }
        }
      }
    });

    const app = createApp({ supabase });
    const res = await sendWebhook(app, 'evt_checkout_site_only');

    expect(res.status).toBe(200);
    expect(captureServerEvent).toHaveBeenCalledWith({
      event: 'payment_succeeded',
      distinctId: 'site_internal_only',
      properties: expect.objectContaining({
        site_id: 'site_internal_only',
        site_hash: 'site_hash_only',
        stripe_customer_id: 'cus_site_only',
        license_key: null,
        account_id: null
      })
    });
  });

  test('uses metadata account_id as the highest-priority identity path', async () => {
    const supabase = createSupabaseMock({
      accounts: [
        {
          id: 'account_meta',
          email: 'meta@example.com',
          license_key: 'lic_meta_account',
          plan: 'agency'
        }
      ]
    });

    verifyWebhookSignature.mockReturnValue({
      id: 'evt_checkout_account_metadata',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_account_metadata',
          mode: 'payment',
          payment_status: 'paid',
          amount_total: 5999,
          currency: 'usd',
          customer: 'cus_account_meta',
          livemode: false,
          metadata: {
            account_id: 'account_meta',
            license_key: 'lic_meta_account',
            plan: 'agency'
          }
        }
      }
    });

    const app = createApp({ supabase });
    const res = await sendWebhook(app, 'evt_checkout_account_metadata');

    expect(res.status).toBe(200);
    expect(captureServerEvent).toHaveBeenCalledWith({
      event: 'payment_succeeded',
      distinctId: 'account_meta',
      properties: expect.objectContaining({
        account_id: 'account_meta',
        user_id: 'account_meta',
        license_key: 'lic_meta_account',
        identity_path: 'account',
        plan: 'agency'
      })
    });
  });

  test('does not emit payment_succeeded for subscription checkout completion', async () => {
    verifyWebhookSignature.mockReturnValue({
      id: 'evt_checkout_subscription',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_sub_123',
          mode: 'subscription',
          payment_status: 'paid'
        }
      }
    });

    const app = createApp();
    const res = await sendWebhook(app, 'evt_checkout_subscription');

    expect(res.status).toBe(200);
    expect(captureServerEvent).not.toHaveBeenCalled();
  });

  test('tracks invoice.payment_succeeded for subscription payments and persists stripe subscription mappings', async () => {
    const supabase = createSupabaseMock({
      accounts: [
        {
          id: 'account_456',
          email: 'subscriber@example.com',
          license_key: 'lic_456',
          stripe_customer_id: 'cus_456',
          plan: 'pro'
        }
      ]
    });

    verifyWebhookSignature.mockReturnValue({
      id: 'evt_invoice_paid',
      type: 'invoice.payment_succeeded',
      data: {
        object: {
          id: 'in_123',
          amount_paid: 1499,
          currency: 'usd',
          customer: 'cus_456',
          subscription: 'sub_456',
          billing_reason: 'subscription_create',
          livemode: true,
          metadata: {},
          lines: {
            data: [{ price: { id: 'price_pro', product: 'prod_pro', recurring: { interval: 'month' } } }]
          }
        }
      }
    });

    const app = createApp({ supabase });
    const res = await sendWebhook(app, 'evt_invoice_paid');

    expect(res.status).toBe(200);
    expect(captureServerEvent).toHaveBeenCalledWith({
      event: 'payment_succeeded',
      distinctId: 'account_456',
      properties: expect.objectContaining({
        source: 'stripe_webhook',
        stripe_event_id: 'evt_invoice_paid',
        stripe_event_type: 'invoice.payment_succeeded',
        amount: 14.99,
        amount_minor: 1499,
        revenue: 14.99,
        currency: 'usd',
        plan: 'pro',
        price_id: 'price_pro',
        product_id: 'prod_pro',
        stripe_customer_id: 'cus_456',
        stripe_subscription_id: 'sub_456',
        invoice_id: 'in_123',
        checkout_session_id: null,
        payment_link_id: null,
        site_id: null,
        site_hash: null,
        email: 'subscriber@example.com',
        account_id: 'account_456',
        user_id: 'account_456',
        license_key: 'lic_456',
        license_key_present: true,
        billing_reason: 'subscription_create',
        billing_period: 'monthly',
        purchase_type: 'subscription',
        livemode: true,
        payment_mode: null,
        $insert_id: 'evt_invoice_paid'
      })
    });
    expect(supabase.updates).toEqual([
      {
        table: 'licenses',
        column: 'id',
        value: 'account_456',
        payload: { stripe_subscription_id: 'sub_456' }
      }
    ]);
    expect(identifyServerUser).toHaveBeenCalledWith({
      distinctId: 'account_456',
      properties: {
        email: 'subscriber@example.com',
        stripe_customer_id: 'cus_456',
        stripe_subscription_id: 'sub_456',
        license_key: 'lic_456',
        plan: 'pro'
      }
    });
  });

  test('still emits a fallback payment_succeeded event when checkout enrichment fails', async () => {
    const stripeClient = {
      checkout: {
        sessions: {
          listLineItems: jest.fn().mockRejectedValue(new Error('Stripe lookup failed'))
        }
      }
    };

    const supabase = createSupabaseMock({
      accounts: [
        {
          id: 'account_fail',
          license_key: 'lic_fail',
          plan: 'free'
        }
      ]
    });

    verifyWebhookSignature.mockReturnValue({
      id: 'evt_checkout_enrichment_fail',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_fail',
          mode: 'payment',
          payment_status: 'paid',
          amount_total: 999,
          currency: 'usd',
          customer: 'cus_fail',
          livemode: false,
          metadata: {
            license_key: 'lic_fail',
            plan: 'credits'
          }
        }
      }
    });

    const app = createApp({ supabase, stripeClient });
    const res = await sendWebhook(app, 'evt_checkout_enrichment_fail');

    expect(res.status).toBe(200);
    expect(captureServerEvent).toHaveBeenCalledWith({
      event: 'payment_succeeded',
      distinctId: 'account_fail',
      properties: expect.objectContaining({
        stripe_event_id: 'evt_checkout_enrichment_fail',
        price_id: null,
        product_id: null,
        plan: 'credits',
        amount: 9.99,
        revenue: 9.99,
        purchase_type: 'one_time',
        billing_period: 'one_time'
      })
    });
  });

  test('skips checkout line item lookup when the Stripe key mode does not match the webhook event mode', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_live_mock';

    const stripeClient = {
      checkout: {
        sessions: {
          listLineItems: jest.fn()
        }
      }
    };

    verifyWebhookSignature.mockReturnValue({
      id: 'evt_checkout_mode_mismatch',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_mode_mismatch',
          mode: 'payment',
          payment_status: 'paid',
          amount_total: 1200,
          currency: 'usd',
          customer: 'cus_mode_mismatch',
          livemode: false,
          metadata: {
            plan: 'credits'
          }
        }
      }
    });

    const app = createApp({ stripeClient, supabase: createSupabaseMock() });
    const res = await sendWebhook(app, 'evt_checkout_mode_mismatch');

    expect(res.status).toBe(200);
    expect(stripeClient.checkout.sessions.listLineItems).not.toHaveBeenCalled();
    expect(captureServerEvent).toHaveBeenCalledWith({
      event: 'payment_succeeded',
      distinctId: 'cus_mode_mismatch',
      properties: expect.objectContaining({
        stripe_event_id: 'evt_checkout_mode_mismatch',
        price_id: null,
        product_id: null,
        plan: 'credits',
        billing_period: 'one_time',
        purchase_type: 'one_time'
      })
    });
  });

  test('uses Stripe event id as the duplicate-safe insert id', async () => {
    verifyWebhookSignature.mockReturnValue({
      id: 'evt_duplicate',
      type: 'invoice.payment_succeeded',
      data: {
        object: {
          id: 'in_duplicate',
          amount_paid: 2000,
          currency: 'usd',
          customer: 'cus_duplicate',
          subscription: null,
          billing_reason: 'manual',
          livemode: false,
          metadata: {},
          lines: {
            data: [{ price: { id: 'price_credits', product: 'prod_credits' } }]
          }
        }
      }
    });

    const app = createApp({ supabase: createSupabaseMock() });

    await sendWebhook(app, 'evt_duplicate');
    await sendWebhook(app, 'evt_duplicate');

    expect(captureServerEvent).toHaveBeenCalledTimes(2);
    const insertIds = captureServerEvent.mock.calls.map(([payload]) => payload.properties.$insert_id);
    expect(insertIds).toEqual(['evt_duplicate', 'evt_duplicate']);
  });

  test('falls back to email distinct id only after internal and Stripe ids are unavailable', async () => {
    verifyWebhookSignature.mockReturnValue({
      id: 'evt_checkout_email_fallback',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_email_fallback',
          mode: 'payment',
          payment_status: 'paid',
          amount_total: 799,
          currency: 'usd',
          customer: null,
          subscription: null,
          livemode: false,
          customer_details: {
            email: 'fallback@example.com'
          },
          metadata: {
            plan: 'credits'
          }
        }
      }
    });

    const app = createApp({ supabase: createSupabaseMock() });
    const res = await sendWebhook(app, 'evt_checkout_email_fallback');

    expect(res.status).toBe(200);
    expect(captureServerEvent).toHaveBeenCalledWith({
      event: 'payment_succeeded',
      distinctId: 'fallback@example.com',
      properties: expect.objectContaining({
        stripe_event_id: 'evt_checkout_email_fallback',
        stripe_customer_id: null,
        stripe_subscription_id: null,
        email: 'fallback@example.com',
        identity_path: 'email',
        plan: 'credits'
      })
    });
  });
});
