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

function createSupabaseMock({ byEmail = {}, byStripeCustomerId = {} } = {}) {
  const updates = [];

  return {
    updates,
    from(table) {
      expect(table).toBe('licenses');

      return {
        select() {
          return {
            eq(column, value) {
              if (column === 'email') {
                return {
                  maybeSingle: jest.fn().mockResolvedValue({
                    data: byEmail[value] || null,
                    error: null
                  })
                };
              }

              if (column === 'stripe_customer_id') {
                return {
                  maybeSingle: jest.fn().mockResolvedValue({
                    data: byStripeCustomerId[value] || null,
                    error: null
                  })
                };
              }

              return {
                maybeSingle: jest.fn().mockResolvedValue({
                  data: null,
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
                      updates.push({ column, value, payload });

                      const existing =
                        Object.values(byEmail).find((row) => row.id === value)
                        || Object.values(byStripeCustomerId).find((row) => row.id === value)
                        || null;

                      const updated = {
                        ...(existing || {}),
                        ...payload,
                        id: existing?.id || value
                      };

                      if (updated.email) {
                        byEmail[updated.email] = updated;
                      }

                      if (existing?.stripe_customer_id) {
                        delete byStripeCustomerId[existing.stripe_customer_id];
                      }

                      if (updated.stripe_customer_id) {
                        byStripeCustomerId[updated.stripe_customer_id] = updated;
                      }

                      return {
                        data: updated,
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

describe('POST /billing/webhook', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('rejects invalid webhook signatures', async () => {
    verifyWebhookSignature.mockImplementation(() => {
      throw new Error('bad signature');
    });

    const app = createApp();
    const res = await request(app)
      .post('/billing/webhook')
      .set('Stripe-Signature', 'sig_test')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ id: 'evt_invalid' }));

    expect(res.status).toBe(400);
    expect(captureServerEvent).not.toHaveBeenCalled();
  });

  test('tracks one-time checkout.session.completed payments', async () => {
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
      byEmail: {
        'buyer@example.com': {
          id: 'user_123',
          email: 'buyer@example.com',
          license_key: 'lic_123',
          stripe_customer_id: null
        }
      }
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
    const res = await request(app)
      .post('/billing/webhook')
      .set('Stripe-Signature', 'sig_test')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ id: 'evt_checkout_paid' }));

    expect(res.status).toBe(200);
    expect(stripeClient.checkout.sessions.listLineItems).toHaveBeenCalledWith('cs_test_123', { limit: 1 });
    expect(captureServerEvent).toHaveBeenCalledWith({
      event: 'payment_succeeded',
      distinctId: 'user_123',
      properties: expect.objectContaining({
        source: 'stripe_webhook',
        stripe_event_id: 'evt_checkout_paid',
        stripe_event_type: 'checkout.session.completed',
        amount: 19.99,
        amount_minor: 1999,
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
        email: 'buyer@example.com',
        user_id: 'user_123',
        license_key: 'lic_123',
        license_key_present: true,
        livemode: false,
        payment_mode: 'payment',
        billing_reason: null,
        $insert_id: 'evt_checkout_paid'
      })
    });
    expect(supabase.updates).toEqual([
      {
        column: 'id',
        value: 'user_123',
        payload: { stripe_customer_id: 'cus_123' }
      }
    ]);
    expect(identifyServerUser).toHaveBeenCalledWith({
      distinctId: 'user_123',
      properties: {
        email: 'buyer@example.com',
        stripe_customer_id: 'cus_123',
        license_key: 'lic_123'
      }
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
    const res = await request(app)
      .post('/billing/webhook')
      .set('Stripe-Signature', 'sig_test')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ id: 'evt_checkout_subscription' }));

    expect(res.status).toBe(200);
    expect(captureServerEvent).not.toHaveBeenCalled();
  });

  test('tracks invoice.payment_succeeded for subscription payments', async () => {
    const supabase = createSupabaseMock({
      byStripeCustomerId: {
        cus_456: {
          id: 'user_456',
          email: 'subscriber@example.com',
          license_key: 'lic_456',
          stripe_customer_id: 'cus_456'
        }
      }
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
            data: [{ price: { id: 'price_pro', product: 'prod_pro' } }]
          }
        }
      }
    });

    const app = createApp({ supabase });
    const res = await request(app)
      .post('/billing/webhook')
      .set('Stripe-Signature', 'sig_test')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ id: 'evt_invoice_paid' }));

    expect(res.status).toBe(200);
    expect(captureServerEvent).toHaveBeenCalledWith({
      event: 'payment_succeeded',
      distinctId: 'user_456',
      properties: expect.objectContaining({
        source: 'stripe_webhook',
        stripe_event_id: 'evt_invoice_paid',
        stripe_event_type: 'invoice.payment_succeeded',
        amount: 14.99,
        amount_minor: 1499,
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
        email: 'subscriber@example.com',
        user_id: 'user_456',
        license_key: 'lic_456',
        license_key_present: true,
        billing_reason: 'subscription_create',
        livemode: true,
        payment_mode: null,
        $insert_id: 'evt_invoice_paid'
      })
    });
    expect(identifyServerUser).toHaveBeenCalledWith({
      distinctId: 'user_456',
      properties: {
        email: 'subscriber@example.com',
        stripe_customer_id: 'cus_456',
        license_key: 'lic_456'
      }
    });
  });

  test('still returns 200 when no account is found for the payment', async () => {
    verifyWebhookSignature.mockReturnValue({
      id: 'evt_invoice_paid_unknown',
      type: 'invoice.payment_succeeded',
      data: {
        object: {
          id: 'in_unknown',
          amount_paid: 999,
          currency: 'usd',
          customer: 'cus_unknown',
          subscription: 'sub_unknown',
          billing_reason: 'subscription_cycle',
          livemode: false,
          metadata: {},
          lines: {
            data: [{ price: { id: 'price_pro', product: 'prod_pro' } }]
          }
        }
      }
    });

    const app = createApp({ supabase: createSupabaseMock() });
    const res = await request(app)
      .post('/billing/webhook')
      .set('Stripe-Signature', 'sig_test')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ id: 'evt_invoice_paid_unknown' }));

    expect(res.status).toBe(200);
    expect(captureServerEvent).toHaveBeenCalledWith({
      event: 'payment_succeeded',
      distinctId: 'cus_unknown',
      properties: expect.objectContaining({
        stripe_customer_id: 'cus_unknown',
        user_id: null,
        email: null,
        license_key: null,
        license_key_present: false
      })
    });
    expect(identifyServerUser).not.toHaveBeenCalled();
  });
});
