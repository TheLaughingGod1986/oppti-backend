const express = require('express');
const request = require('supertest');

const { createBillingRouter } = require('../../routes/billing');

function createSupabaseMock({ siteRecord = null } = {}) {
  return {
    from(table) {
      if (table !== 'sites') {
        throw new Error(`Unexpected table: ${table}`);
      }

      return {
        select() {
          return {
            eq(column, value) {
              expect(column).toBe('site_hash');
              expect(value).toBe(siteRecord?.site_hash || null);

              return {
                maybeSingle: jest.fn().mockResolvedValue({
                  data: siteRecord,
                  error: null
                })
              };
            }
          };
        }
      };
    }
  };
}

function createApp({ supabase, stripeClient, license, user }) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.license = license || null;
    req.user = user || null;
    next();
  });
  app.use('/billing', createBillingRouter({
    supabase,
    getStripe: () => stripeClient,
    priceIds: {
      pro: 'price_pro',
      agency: 'price_agency',
      credits: 'price_credits'
    }
  }));
  return app;
}

describe('POST /billing/checkout', () => {
  test('propagates internal metadata onto subscription checkout sessions', async () => {
    const stripeClient = {
      checkout: {
        sessions: {
          create: jest.fn().mockResolvedValue({
            id: 'cs_subscription',
            url: 'https://stripe.test/session'
          })
        }
      }
    };

    const supabase = createSupabaseMock({
      siteRecord: {
        id: 'site_123',
        site_hash: 'site_hash_123',
        license_key: 'lic_123'
      }
    });

    const app = createApp({
      supabase,
      stripeClient,
      license: {
        id: 'account_123',
        email: 'buyer@example.com',
        license_key: 'lic_123',
        stripe_customer_id: 'cus_existing'
      }
    });

    const res = await request(app)
      .post('/billing/checkout')
      .set('X-Site-Key', 'site_hash_123')
      .send({
        priceId: 'price_agency',
        successUrl: 'https://app.example.com/success',
        cancelUrl: 'https://app.example.com/cancel'
      });

    expect(res.status).toBe(200);
    expect(stripeClient.checkout.sessions.create).toHaveBeenCalledWith(expect.objectContaining({
      mode: 'subscription',
      customer: 'cus_existing',
      client_reference_id: 'account_123',
      success_url: 'https://app.example.com/success',
      cancel_url: 'https://app.example.com/cancel',
      metadata: expect.objectContaining({
        account_id: 'account_123',
        license_key: 'lic_123',
        site_id: 'site_123',
        site_hash: 'site_hash_123',
        user_id: 'account_123',
        plan: 'agency',
        source: 'app'
      }),
      subscription_data: {
        metadata: expect.objectContaining({
          account_id: 'account_123',
          license_key: 'lic_123',
          site_id: 'site_123',
          site_hash: 'site_hash_123',
          user_id: 'account_123',
          plan: 'agency',
          source: 'app'
        })
      }
    }));
  });

  test('uses payment mode and metadata propagation for one-time credit purchases', async () => {
    const stripeClient = {
      checkout: {
        sessions: {
          create: jest.fn().mockResolvedValue({
            id: 'cs_payment',
            url: 'https://stripe.test/payment'
          })
        }
      }
    };

    const supabase = createSupabaseMock({
      siteRecord: {
        id: 'site_credits',
        site_hash: 'site_hash_credits',
        license_key: 'lic_credits'
      }
    });

    const app = createApp({
      supabase,
      stripeClient,
      license: {
        id: 'account_credits',
        email: 'credits@example.com',
        license_key: 'lic_credits'
      }
    });

    const res = await request(app)
      .post('/billing/checkout')
      .set('X-Site-Key', 'site_hash_credits')
      .send({
        priceId: 'price_credits'
      });

    expect(res.status).toBe(200);
    expect(stripeClient.checkout.sessions.create).toHaveBeenCalledWith(expect.objectContaining({
      mode: 'payment',
      customer_email: 'credits@example.com',
      client_reference_id: 'account_credits',
      metadata: expect.objectContaining({
        account_id: 'account_credits',
        license_key: 'lic_credits',
        site_id: 'site_credits',
        site_hash: 'site_hash_credits',
        user_id: 'account_credits',
        plan: 'credits',
        source: 'app'
      }),
      payment_intent_data: {
        metadata: expect.objectContaining({
          account_id: 'account_credits',
          license_key: 'lic_credits',
          site_id: 'site_credits',
          site_hash: 'site_hash_credits',
          user_id: 'account_credits',
          plan: 'credits',
          source: 'app'
        })
      }
    }));
  });
});
