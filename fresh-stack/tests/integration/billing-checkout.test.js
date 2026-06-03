const express = require('express');
const request = require('supertest');

const { createBillingRouter } = require('../../routes/billing');

function createSupabaseMock({ siteRecord = null, siteSubscriptions = [] } = {}) {
  const normalizedSiteRecord = siteRecord
    ? {
        wp_install_uuid: siteRecord.wp_install_uuid || siteRecord.site_hash || null,
        normalized_site_url: siteRecord.normalized_site_url || null,
        canonical_domain: siteRecord.canonical_domain || null,
        site_fingerprint: siteRecord.site_fingerprint || null,
        fingerprint: siteRecord.fingerprint || null,
        ...siteRecord
      }
    : null;

  return {
    from(table) {
      if (table === 'site_memberships') {
        return {
          select() {
            return {
              eq() {
                return {
                  eq() {
                    return {
                      maybeSingle: jest.fn().mockResolvedValue({
                        data: null,
                        error: null
                      })
                    };
                  }
                };
              }
            };
          },
          insert(payload) {
            return {
              select() {
                return {
                  single: jest.fn().mockResolvedValue({
                    data: {
                      id: 'membership_123',
                      site_id: payload.site_id,
                      user_id: payload.user_id,
                      role: payload.role
                    },
                    error: null
                  })
                };
              }
            };
          }
        };
      }

      if (table === 'site_subscriptions') {
        return {
          select() {
            const filters = [];
            const query = {
              eq(column, value) {
                filters.push((row) => row?.[column] === value);
                return query;
              },
              in(column, values) {
                filters.push((row) => values.includes(row?.[column]));
                return query;
              },
              order() {
                return query;
              },
              limit() {
                const rows = siteSubscriptions.filter((row) => filters.every((filter) => filter(row)));
                return Promise.resolve({ data: rows.slice(0, 1), error: null });
              }
            };
            return query;
          }
        };
      }

      if (table !== 'sites') {
        throw new Error(`Unexpected table: ${table}`);
      }

      return {
        select() {
          return {
            eq(column, value) {
              const matches = normalizedSiteRecord
                && (
                  normalizedSiteRecord[column] === value
                  || (column === 'wp_install_uuid' && normalizedSiteRecord.site_hash === value)
                );

              const result = matches ? normalizedSiteRecord : null;

              return {
                maybeSingle: jest.fn().mockResolvedValue({
                  data: result,
                  error: null
                }),
                then: (resolve, reject) => Promise.resolve({
                  data: result ? [result] : [],
                  error: null
                }).then(resolve, reject)
              };
            }
          };
        },
        update(payload) {
          return {
            eq(column, value) {
              if (normalizedSiteRecord && normalizedSiteRecord[column] === value) {
                Object.assign(normalizedSiteRecord, payload);
              }

              return {
                select() {
                  return {
                    single: jest.fn().mockResolvedValue({
                      data: normalizedSiteRecord,
                      error: null
                    })
                  };
                },
                then: (resolve, reject) => Promise.resolve({ data: null, error: null }).then(resolve, reject)
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
        plan: 'free',
        stripe_customer_id: 'cus_existing'
      }
    });

    const res = await request(app)
      .post('/billing/checkout')
      .set('X-Site-Key', 'site_hash_123')
      .send({
        priceId: 'price_agency',
        successUrl: 'https://app.example.com/success',
        cancelUrl: 'https://app.example.com/cancel',
        account_id: 'frontend_account_override',
        user_id: 'user_987',
        license_key: 'frontend_license_override',
        site_id: 'frontend_site_override',
        site_hash: 'frontend_hash_override',
        email: 'frontend@example.com',
        trigger_feature: 'bulk-generate',
        trigger_location: 'upgrade-modal',
        source_page: '/dashboard/media',
        target_plan: 'agency',
        source: 'wordpress_plugin'
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
        user_id: 'user_987',
        email: 'buyer@example.com',
        plan: 'agency',
        current_plan: 'free',
        billing_interval: 'month',
        purchase_type: 'new_purchase',
        trigger_feature: 'bulk-generate',
        trigger_location: 'upgrade-modal',
        source_page: '/dashboard/media',
        target_plan: 'agency',
        source: 'app'
      }),
      subscription_data: {
        metadata: expect.objectContaining({
          account_id: 'account_123',
          license_key: 'lic_123',
          site_id: 'site_123',
          site_hash: 'site_hash_123',
          user_id: 'user_987',
          email: 'buyer@example.com',
          plan: 'agency',
          current_plan: 'free',
          billing_interval: 'month',
          purchase_type: 'new_purchase',
          trigger_feature: 'bulk-generate',
          trigger_location: 'upgrade-modal',
          source_page: '/dashboard/media',
          target_plan: 'agency',
          source: 'app'
        })
      }
    }), expect.objectContaining({
      idempotencyKey: expect.stringMatching(/^checkout:/)
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
        license_key: 'lic_credits',
        plan: 'pro'
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
        email: 'credits@example.com',
        plan: 'credits',
        current_plan: 'pro',
        billing_interval: 'one_time',
        purchase_type: 'credit_top_up',
        source: 'app'
      }),
      payment_intent_data: {
        metadata: expect.objectContaining({
          account_id: 'account_credits',
          license_key: 'lic_credits',
          site_id: 'site_credits',
          site_hash: 'site_hash_credits',
          user_id: 'account_credits',
          email: 'credits@example.com',
          plan: 'credits',
          current_plan: 'pro',
          billing_interval: 'one_time',
          purchase_type: 'credit_top_up',
          source: 'app'
        })
      }
    }), expect.objectContaining({
      idempotencyKey: expect.stringMatching(/^checkout:/)
    }));
  });

  test('redirects active subscription customers to the billing portal instead of creating checkout', async () => {
    const stripeClient = {
      checkout: {
        sessions: {
          create: jest.fn()
        }
      },
      billingPortal: {
        sessions: {
          create: jest.fn().mockResolvedValue({
            url: 'https://stripe.test/portal'
          })
        }
      }
    };

    const supabase = createSupabaseMock({
      siteRecord: {
        id: 'site_paid',
        site_hash: 'site_hash_paid',
        license_key: 'lic_paid'
      },
      siteSubscriptions: [{
        id: 'site_sub_paid',
        site_id: 'site_paid',
        plan_id: 'pro',
        stripe_customer_id: 'cus_paid',
        stripe_subscription_id: 'sub_paid',
        status: 'active',
        billing_interval: 'month',
        current_period_end: '2026-07-01T00:00:00.000Z'
      }]
    });

    const app = createApp({
      supabase,
      stripeClient,
      license: {
        id: 'account_paid',
        email: 'paid@example.com',
        license_key: 'lic_paid',
        plan: 'pro',
        stripe_customer_id: 'cus_paid'
      }
    });

    const res = await request(app)
      .post('/billing/checkout')
      .set('X-Site-Key', 'site_hash_paid')
      .send({
        priceId: 'price_pro',
        cancelUrl: 'https://app.example.com/billing'
      });

    expect(res.status).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({
      success: true,
      url: 'https://stripe.test/portal',
      portal: true,
      customerId: 'cus_paid',
      subscriptionId: 'sub_paid'
    }));
    expect(stripeClient.billingPortal.sessions.create).toHaveBeenCalledWith({
      customer: 'cus_paid',
      return_url: 'https://app.example.com/billing'
    });
    expect(stripeClient.checkout.sessions.create).not.toHaveBeenCalled();
  });
});
