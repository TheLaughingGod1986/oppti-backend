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
const logger = require('../../lib/logger');
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

function normalizeSiteSubscription(subscription = {}) {
  return {
    id: subscription.id || `site_sub_${subscription.site_id || 'unknown'}`,
    site_id: subscription.site_id || null,
    stripe_customer_id: null,
    stripe_subscription_id: null,
    status: 'active',
    ...subscription
  };
}

function createSupabaseMock({
  accounts = [],
  sites = [],
  siteSubscriptions = [],
  enableBillingRpc = false,
  failBillingRpc = false
} = {}) {
  const updates = [];
  const accountRows = accounts.map((account) => normalizeAccount(account));
  const siteRows = sites.map((site) => normalizeSite(site));
  const siteSubscriptionRows = siteSubscriptions.map((subscription) => normalizeSiteSubscription(subscription));
  const billingEventIds = new Set();

  const findAccount = (column, value) => accountRows.find((row) => row[column] === value) || null;
  const findSite = (column, value) => siteRows.find((row) => row[column] === value) || null;
  const filterSiteSubscriptions = (column, value) => siteSubscriptionRows.filter((row) => row[column] === value);

  const supabase = {
    updates,
    siteSubscriptions: siteSubscriptionRows,
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
                  }),
                  single: jest.fn().mockResolvedValue({
                    data: findSite(column, value),
                    error: null
                  }),
                  then: (resolve, reject) => Promise.resolve({
                    data: findSite(column, value) ? [findSite(column, value)] : [],
                    error: null
                  }).then(resolve, reject)
                };
              }
            };
          },
          update(payload) {
            return {
              eq(column, value) {
                const existing = findSite(column, value);
                if (existing) Object.assign(existing, payload);
                return {
                  then: (resolve, reject) => Promise.resolve({ data: null, error: null }).then(resolve, reject)
                };
              }
            };
          }
        };
      }

      if (table === 'site_subscriptions') {
        return {
          select() {
            const state = {
              rows: siteSubscriptionRows.slice()
            };

            const chain = {
              eq(column, value) {
                state.rows = state.rows.filter((row) => row[column] === value);
                return chain;
              },
              in(column, values) {
                state.rows = state.rows.filter((row) => values.includes(row[column]));
                return chain;
              },
              order(column, { ascending = true } = {}) {
                state.rows = state.rows.slice().sort((left, right) => {
                  if (left[column] === right[column]) return 0;
                  if (left[column] == null) return ascending ? 1 : -1;
                  if (right[column] == null) return ascending ? -1 : 1;
                  return ascending
                    ? String(left[column]).localeCompare(String(right[column]))
                    : String(right[column]).localeCompare(String(left[column]));
                });
                return chain;
              },
              limit(count) {
                state.rows = state.rows.slice(0, count);
                return Promise.resolve({ data: state.rows, error: null });
              },
              maybeSingle: jest.fn().mockImplementation(async () => ({
                data: state.rows[0] || null,
                error: null
              })),
              single: jest.fn().mockImplementation(async () => ({
                data: state.rows[0] || null,
                error: null
              })),
              then(resolve, reject) {
                return Promise.resolve({ data: state.rows, error: null }).then(resolve, reject);
              }
            };

            return chain;
          }
        };
      }

      throw new Error(`Unexpected table: ${table}`);
    }
  };

  if (enableBillingRpc || failBillingRpc) {
    supabase.rpc = jest.fn().mockImplementation(async (name, payload) => {
      if (name !== 'bbai_apply_site_billing_event') {
        return { data: null, error: { code: '42883', message: 'unknown function' } };
      }

      if (failBillingRpc) {
        return {
          data: null,
          error: {
            code: 'PGRST500',
            message: 'site billing rpc failed'
          }
        };
      }

      const eventId = payload.p_stripe_event_id;
      if (billingEventIds.has(eventId)) {
        return {
          data: { ok: true, duplicate: true, event_id: eventId },
          error: null
        };
      }
      billingEventIds.add(eventId);

      let subscription = siteSubscriptionRows.find((row) => (
        payload.p_stripe_subscription_id
        && row.stripe_subscription_id === payload.p_stripe_subscription_id
      ));

      if (!subscription) {
        subscription = normalizeSiteSubscription({
          id: `site_sub_${siteSubscriptionRows.length + 1}`,
          site_id: payload.p_site_id,
          stripe_subscription_id: payload.p_stripe_subscription_id || null
        });
        siteSubscriptionRows.push(subscription);
      }

      Object.assign(subscription, {
        site_id: payload.p_site_id,
        plan_id: payload.p_plan_id,
        stripe_customer_id: payload.p_stripe_customer_id || null,
        stripe_subscription_id: payload.p_stripe_subscription_id || null,
        status: payload.p_subscription_status || 'active',
        billing_interval: payload.p_billing_interval || 'month',
        current_period_start: payload.p_current_period_start || subscription.current_period_start || null,
        current_period_end: payload.p_current_period_end || subscription.current_period_end || null,
        cancel_at_period_end: false
      });

      return {
        data: {
          ok: true,
          duplicate: false,
          event_id: eventId,
          plan_id: payload.p_plan_id,
          site_subscription_id: subscription.id
        },
        error: null
      };
    });
  }

  return supabase;
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
        purchase_type: 'credit_top_up',
        trigger_feature: null,
        trigger_location: null,
        source_page: null,
        target_plan: null,
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
        purchase_type: 'credit_top_up',
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

  test('enriches checkout.session.completed with attribution metadata when present', async () => {
    const supabase = createSupabaseMock({
      accounts: [
        {
          id: 'account_checkout_attr',
          email: 'checkout-attr@example.com',
          license_key: 'lic_checkout_attr',
          plan: 'free'
        }
      ],
      sites: [
        {
          id: 'site_checkout_attr',
          site_hash: 'site_hash_checkout_attr',
          license_key: 'lic_checkout_attr'
        }
      ]
    });

    verifyWebhookSignature.mockReturnValue({
      id: 'evt_checkout_attribution',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_checkout_attribution',
          mode: 'payment',
          payment_status: 'paid',
          amount_total: 1499,
          currency: 'usd',
          customer: 'cus_checkout_attr',
          livemode: false,
          metadata: {
            account_id: 'account_checkout_attr',
            user_id: 'account_checkout_attr',
            license_key: 'lic_checkout_attr',
            site_id: 'site_checkout_attr',
            site_hash: 'site_hash_checkout_attr',
            plan: 'credits',
            trigger_feature: 'bulk_generate',
            trigger_location: 'dashboard_upgrade_banner',
            source_page: '/wp-admin/upload.php',
            target_plan: 'credits',
            source: 'app'
          }
        }
      }
    });

    const app = createApp({ supabase });
    const res = await sendWebhook(app, 'evt_checkout_attribution');

    expect(res.status).toBe(200);
    expect(captureServerEvent).toHaveBeenCalledWith({
      event: 'payment_succeeded',
      distinctId: 'account_checkout_attr',
      properties: expect.objectContaining({
        stripe_event_id: 'evt_checkout_attribution',
        stripe_event_type: 'checkout.session.completed',
        account_id: 'account_checkout_attr',
        user_id: 'account_checkout_attr',
        license_key: 'lic_checkout_attr',
        site_id: 'site_checkout_attr',
        site_hash: 'site_hash_checkout_attr',
        trigger_feature: 'bulk_generate',
        trigger_location: 'dashboard_upgrade_banner',
        source_page: '/wp-admin/upload.php',
        target_plan: 'credits',
        plan: 'credits',
        purchase_type: 'credit_top_up',
        billing_period: 'one_time'
      })
    });
  });

  test('prefers metadata user_id over license and Stripe ids when no account record is resolved', async () => {
    verifyWebhookSignature.mockReturnValue({
      id: 'evt_checkout_user_id_priority',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_user_id_priority',
          mode: 'payment',
          payment_status: 'paid',
          amount_total: 1500,
          currency: 'usd',
          customer: 'cus_user_id_priority',
          livemode: false,
          metadata: {
            user_id: 'user_internal_123',
            license_key: 'lic_user_priority',
            plan: 'credits'
          }
        }
      }
    });

    const app = createApp({ supabase: createSupabaseMock() });
    const res = await sendWebhook(app, 'evt_checkout_user_id_priority');

    expect(res.status).toBe(200);
    expect(captureServerEvent).toHaveBeenCalledWith({
      event: 'payment_succeeded',
      distinctId: 'user_internal_123',
      properties: expect.objectContaining({
        account_id: null,
        user_id: 'user_internal_123',
        license_key: 'lic_user_priority',
        stripe_customer_id: 'cus_user_id_priority',
        identity_path: 'account'
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
          plan: 'free'
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
        purchase_type: 'new_purchase',
        trigger_feature: null,
        trigger_location: null,
        source_page: null,
        target_plan: null,
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
        plan: 'free'
      }
    });
  });

  test('enriches invoice.payment_succeeded with attribution from subscription metadata', async () => {
    const stripeClient = {
      subscriptions: {
        retrieve: jest.fn().mockResolvedValue({
          id: 'sub_attr',
          metadata: {
            account_id: 'account_attr',
            user_id: 'user_attr',
            license_key: 'lic_attr',
            site_id: 'site_attr',
            site_hash: 'site_hash_attr',
            email: 'attr@example.com',
            plan: 'agency',
            current_plan: 'free',
            billing_interval: 'month',
            purchase_type: 'new_purchase',
            trigger_feature: 'site_scan',
            trigger_location: 'pricing_table',
            source_page: '/pricing',
            target_plan: 'agency',
            source: 'app'
          }
        })
      }
    };

    const supabase = createSupabaseMock({
      accounts: [
        {
          id: 'account_attr',
          email: 'attr@example.com',
          license_key: 'lic_attr',
          stripe_customer_id: 'cus_attr',
          plan: 'free'
        }
      ],
      sites: [
        {
          id: 'site_attr',
          site_hash: 'site_hash_attr',
          license_key: 'lic_attr'
        }
      ]
    });

    verifyWebhookSignature.mockReturnValue({
      id: 'evt_invoice_attribution',
      type: 'invoice.payment_succeeded',
      data: {
        object: {
          id: 'in_attr',
          amount_paid: 5999,
          currency: 'usd',
          customer: 'cus_attr',
          subscription: 'sub_attr',
          billing_reason: 'subscription_create',
          livemode: false,
          metadata: {},
          lines: {
            data: [{ price: { id: 'price_agency', product: 'prod_agency', recurring: { interval: 'month' } } }]
          }
        }
      }
    });

    const app = createApp({ supabase, stripeClient });
    const res = await sendWebhook(app, 'evt_invoice_attribution');

    expect(res.status).toBe(200);
    expect(stripeClient.subscriptions.retrieve).toHaveBeenCalledWith('sub_attr');
    expect(captureServerEvent).toHaveBeenCalledWith({
      event: 'payment_succeeded',
      distinctId: 'account_attr',
      properties: expect.objectContaining({
        stripe_event_id: 'evt_invoice_attribution',
        stripe_event_type: 'invoice.payment_succeeded',
        account_id: 'account_attr',
        user_id: 'user_attr',
        license_key: 'lic_attr',
        site_id: 'site_attr',
        site_hash: 'site_hash_attr',
        plan: 'agency',
        billing_period: 'monthly',
        purchase_type: 'new_purchase',
        trigger_feature: 'site_scan',
        trigger_location: 'pricing_table',
        source_page: '/pricing',
        target_plan: 'agency',
        source: 'stripe_webhook',
        stripe_customer_id: 'cus_attr',
        stripe_subscription_id: 'sub_attr',
        invoice_id: 'in_attr',
        checkout_session_id: null,
        $insert_id: 'evt_invoice_attribution'
      })
    });
  });

  test('reconciles site subscriptions through V2 billing and reuses the row on repeat events', async () => {
    const infoSpy = jest.spyOn(logger, 'info').mockImplementation(() => {});
    const supabase = createSupabaseMock({
      enableBillingRpc: true,
      accounts: [
        {
          id: 'account_site_billing',
          email: 'site-billing@example.com',
          license_key: 'lic_site_billing',
          stripe_customer_id: 'cus_site_billing',
          plan: 'free'
        }
      ],
      sites: [
        {
          id: 'site_billing',
          site_hash: 'site_hash_billing',
          license_key: 'lic_site_billing'
        }
      ]
    });

    verifyWebhookSignature.mockImplementation(({ payload }) => {
      const { id } = JSON.parse(payload.toString());
      const isUpdate = id === 'evt_site_billing_update';
      return {
        id,
        type: 'invoice.payment_succeeded',
        data: {
          object: {
            id: `in_${id}`,
            amount_paid: isUpdate ? 5999 : 1499,
            currency: 'usd',
            customer: 'cus_site_billing',
            subscription: 'sub_site_billing',
            billing_reason: isUpdate ? 'subscription_update' : 'subscription_create',
            livemode: false,
            metadata: {
              license_key: 'lic_site_billing'
            },
            lines: {
              data: [{
                price: {
                  id: isUpdate ? 'price_agency' : 'price_pro',
                  product: isUpdate ? 'prod_agency' : 'prod_pro',
                  recurring: { interval: 'month' }
                }
              }]
            }
          }
        }
      };
    });

    const app = createApp({ supabase });
    await sendWebhook(app, 'evt_site_billing_create');
    await sendWebhook(app, 'evt_site_billing_update');

    expect(supabase.rpc).toHaveBeenCalledTimes(2);
    expect(supabase.siteSubscriptions).toHaveLength(1);
    expect(supabase.siteSubscriptions[0]).toEqual(expect.objectContaining({
      site_id: 'site_billing',
      plan_id: 'agency',
      stripe_customer_id: 'cus_site_billing',
      stripe_subscription_id: 'sub_site_billing',
      status: 'active',
      billing_interval: 'month'
    }));
    expect(infoSpy).toHaveBeenCalledWith('[billing] canonical billing site resolved from license', expect.objectContaining({
      site_id: 'site_billing',
      license_key: 'lic_site_billing'
    }));
    expect(infoSpy).toHaveBeenCalledWith('[billing] site entitlement reconciled', expect.objectContaining({
      stripeEventId: 'evt_site_billing_create',
      siteId: 'site_billing',
      siteSubscriptionId: 'site_sub_1'
    }));
    expect(infoSpy).toHaveBeenCalledWith('[billing] webhook_write_trace', expect.objectContaining({
      stripe_event_id: 'evt_site_billing_update',
      billing_info_source: 'site_subscriptions',
      site_subscription_rpc_executed: true,
      subscriptions_written: true
    }));

    infoSpy.mockRestore();
  });

  test('falls back to legacy license billing when V2 site billing reconciliation fails', async () => {
    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {});
    const supabase = createSupabaseMock({
      enableBillingRpc: true,
      failBillingRpc: true,
      accounts: [
        {
          id: 'account_billing_fallback',
          email: 'billing-fallback@example.com',
          license_key: 'lic_billing_fallback',
          stripe_customer_id: 'cus_billing_fallback',
          plan: 'free'
        }
      ],
      sites: [
        {
          id: 'site_billing_fallback',
          site_hash: 'site_hash_billing_fallback',
          license_key: 'lic_billing_fallback'
        }
      ]
    });

    verifyWebhookSignature.mockReturnValue({
      id: 'evt_billing_fallback',
      type: 'invoice.payment_succeeded',
      data: {
        object: {
          id: 'in_billing_fallback',
          amount_paid: 1499,
          currency: 'usd',
          customer: 'cus_billing_fallback',
          subscription: 'sub_billing_fallback',
          billing_reason: 'subscription_create',
          livemode: false,
          metadata: {
            license_key: 'lic_billing_fallback'
          },
          lines: {
            data: [{
              price: {
                id: 'price_pro',
                product: 'prod_pro',
                recurring: { interval: 'month' }
              }
            }]
          }
        }
      }
    });

    const app = createApp({ supabase });
    const res = await sendWebhook(app, 'evt_billing_fallback');

    expect(res.status).toBe(200);
    expect(supabase.siteSubscriptions).toHaveLength(0);
    expect(supabase.updates).toEqual([
      {
        table: 'licenses',
        column: 'id',
        value: 'account_billing_fallback',
        payload: { stripe_subscription_id: 'sub_billing_fallback' }
      }
    ]);
    expect(warnSpy).toHaveBeenCalledWith('[billing] site entitlement V2 failed; using legacy billing fallback', expect.objectContaining({
      stripeEventId: 'evt_billing_fallback',
      siteId: 'site_billing_fallback',
      plan: 'pro',
      error: 'site billing rpc failed'
    }));

    warnSpy.mockRestore();
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
        purchase_type: 'credit_top_up',
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
        purchase_type: 'credit_top_up'
      })
    });
  });

  test('prefers explicit metadata plan over Stripe price mapping when both exist', async () => {
    const stripeClient = {
      checkout: {
        sessions: {
          listLineItems: jest.fn().mockResolvedValue({
            data: [{ price: { id: 'price_pro', product: 'prod_pro' } }]
          })
        }
      }
    };

    verifyWebhookSignature.mockReturnValue({
      id: 'evt_checkout_plan_metadata',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_plan_metadata',
          mode: 'payment',
          payment_status: 'paid',
          amount_total: 1199,
          currency: 'usd',
          customer: 'cus_plan_metadata',
          livemode: false,
          metadata: {
            plan: 'credits'
          }
        }
      }
    });

    const app = createApp({ stripeClient, supabase: createSupabaseMock() });
    const res = await sendWebhook(app, 'evt_checkout_plan_metadata');

    expect(res.status).toBe(200);
    expect(captureServerEvent).toHaveBeenCalledWith({
      event: 'payment_succeeded',
      distinctId: 'cus_plan_metadata',
      properties: expect.objectContaining({
        stripe_event_id: 'evt_checkout_plan_metadata',
        price_id: 'price_pro',
        product_id: 'prod_pro',
        plan: 'credits',
        purchase_type: 'credit_top_up',
        billing_period: 'one_time'
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

  test('returns 200 and still identifies the account when PostHog capture fails', async () => {
    captureServerEvent.mockResolvedValueOnce({
      ok: false,
      status: 503,
      error: new Error('PostHog unavailable')
    });

    const supabase = createSupabaseMock({
      accounts: [
        {
          id: 'account_fail_open',
          email: 'fail-open@example.com',
          license_key: 'lic_fail_open',
          stripe_customer_id: 'cus_fail_open',
          plan: 'free'
        }
      ]
    });

    verifyWebhookSignature.mockReturnValue({
      id: 'evt_fail_open',
      type: 'invoice.payment_succeeded',
      data: {
        object: {
          id: 'in_fail_open',
          amount_paid: 1499,
          currency: 'usd',
          customer: 'cus_fail_open',
          subscription: 'sub_fail_open',
          billing_reason: 'subscription_create',
          livemode: false,
          metadata: {},
          lines: {
            data: [{ price: { id: 'price_pro', product: 'prod_pro', recurring: { interval: 'month' } } }]
          }
        }
      }
    });

    const app = createApp({ supabase });
    const res = await sendWebhook(app, 'evt_fail_open');

    expect(res.status).toBe(200);
    expect(captureServerEvent).toHaveBeenCalledWith({
      event: 'payment_succeeded',
      distinctId: 'account_fail_open',
      properties: expect.objectContaining({
        stripe_event_id: 'evt_fail_open',
        $insert_id: 'evt_fail_open'
      })
    });
    expect(identifyServerUser).toHaveBeenCalledWith({
      distinctId: 'account_fail_open',
      properties: {
        email: 'fail-open@example.com',
        stripe_customer_id: 'cus_fail_open',
        stripe_subscription_id: 'sub_fail_open',
        license_key: 'lic_fail_open',
        plan: 'free'
      }
    });
  });

  test('falls back to checkout session distinct id after internal and Stripe ids are unavailable', async () => {
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
      distinctId: 'cs_email_fallback',
      properties: expect.objectContaining({
        stripe_event_id: 'evt_checkout_email_fallback',
        stripe_customer_id: null,
        stripe_subscription_id: null,
        email: 'fallback@example.com',
        identity_path: 'session',
        plan: 'credits'
      })
    });
  });
});
