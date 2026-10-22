const express = require('express');
const request = require('supertest');

jest.mock('../../lib/stripe', () => ({ verifyWebhookSignature: jest.fn() }));
jest.mock('../../lib/posthog', () => ({
  captureServerEvent: jest.fn().mockResolvedValue({ ok: true, status: 200 }),
  identifyServerUser: jest.fn().mockResolvedValue({ ok: true, status: 200 }),
  aliasServerUser: jest.fn().mockResolvedValue({ ok: true, status: 200 })
}));
jest.mock('../../../src/services/loops', () => ({
  trackPaymentFailed: jest.fn().mockResolvedValue(null),
  trackPaymentSucceeded: jest.fn().mockResolvedValue(null),
  trackPlanUpgraded: jest.fn().mockResolvedValue(null)
}));

const { verifyWebhookSignature } = require('../../lib/stripe');
const { createBillingWebhookHandler } = require('../../routes/billing');

const PERIOD_START = 1790949087; // 2026-10-02T13:51:27Z
const PERIOD_END = 1793627487; // 2026-11-02T13:51:27Z

function createSupabaseStub() {
  const account = {
    id: 'acct_periods', email: 'periods@qa.oppti.dev', license_key: 'lic_periods',
    stripe_customer_id: 'cus_periods', stripe_subscription_id: 'sub_periods', plan: 'pro', billing_cycle: 'monthly'
  };
  const site = { id: 'site_periods', site_hash: 'hash_periods', license_key: 'lic_periods' };
  const siteSub = {
    id: 'site_sub_periods', site_id: 'site_periods', plan_id: 'pro', stripe_customer_id: 'cus_periods',
    stripe_subscription_id: 'sub_periods', status: 'active',
    current_period_start: '2026-10-02T13:51:27.000Z', current_period_end: '2026-11-02T13:51:27.000Z'
  };
  const siteSubUpdates = [];
  const one = (rows) => ({
    maybeSingle: async () => ({ data: rows[0] || null, error: null }),
    single: async () => ({ data: rows[0] || null, error: null }),
    then: (resolve, reject) => Promise.resolve({ data: rows, error: null }).then(resolve, reject)
  });
  return {
    siteSub,
    siteSubUpdates,
    rpc: jest.fn(async () => ({ data: { ok: true, site_subscription_id: siteSub.id }, error: null })),
    from(table) {
      if (table === 'licenses') {
        return {
          select: () => ({ eq: (c, v) => one(account[c] === v ? [account] : []) }),
          update: (payload) => ({
            eq: () => {
              Object.assign(account, payload);
              const result = { data: { ...account }, error: null };
              return { select: () => ({ single: async () => result }), then: (r, j) => Promise.resolve(result).then(r, j) };
            }
          })
        };
      }
      if (table === 'sites') {
        return {
          select: () => ({ eq: (c, v) => one(site[c] === v ? [site] : []) }),
          update: () => ({ eq: () => one([]) })
        };
      }
      if (table === 'site_subscriptions') {
        const rowsFor = (c, v) => (siteSub[c] === v ? [siteSub] : []);
        return {
          select: () => {
            let rows = [siteSub];
            const chain = {
              eq: (c, v) => { rows = rows.filter((r) => r[c] === v); return chain; },
              order: () => chain,
              limit: async () => ({ data: rows, error: null }),
              maybeSingle: async () => ({ data: rows[0] || null, error: null })
            };
            return chain;
          },
          update: (payload) => ({
            eq: (c, v) => ({
              select: () => ({
                maybeSingle: async () => {
                  siteSubUpdates.push(payload);
                  const rows = rowsFor(c, v);
                  if (rows[0]) Object.assign(rows[0], payload);
                  return { data: rows[0] ? { ...rows[0] } : null, error: null };
                }
              })
            })
          })
        };
      }
      throw new Error(`Unexpected table: ${table}`);
    }
  };
}

function createApp(supabase) {
  const app = express();
  app.post('/billing/webhook', express.raw({ type: 'application/json' }), createBillingWebhookHandler({
    supabase,
    getStripe: () => null,
    webhookSecret: 'whsec_test',
    priceIds: { starter: 'price_starter', pro: 'price_pro', agency: 'price_agency', credits: 'price_credits' }
  }));
  return app;
}

// customer.subscription.updated as sent on Stripe API >= 2025-03-31 (dahlia):
// no top-level current_period_*; the period lives on each subscription item.
function dahliaSubscriptionEvent({ status = 'active', itemPeriod = true } = {}) {
  return {
    id: `evt_sub_${status}_${itemPeriod}`,
    type: 'customer.subscription.updated',
    data: {
      object: {
        id: 'sub_periods',
        object: 'subscription',
        status,
        customer: 'cus_periods',
        livemode: false,
        cancel_at_period_end: false,
        metadata: {},
        items: {
          data: [{
            id: 'si_periods',
            ...(itemPeriod ? { current_period_start: PERIOD_START, current_period_end: PERIOD_END } : {}),
            price: { id: 'price_pro', product: 'prod_pro', recurring: { interval: 'month' } }
          }]
        }
      }
    }
  };
}

const send = (app) => request(app).post('/billing/webhook')
  .set('Stripe-Signature', 'sig_test').set('Content-Type', 'application/json').send('{}');

describe('customer.subscription.updated with dahlia item-level periods', () => {
  beforeEach(() => jest.clearAllMocks());

  test('reads current_period_start/end from items.data[0]', async () => {
    const supabase = createSupabaseStub();
    verifyWebhookSignature.mockReturnValue(dahliaSubscriptionEvent());

    const res = await send(createApp(supabase));

    expect(res.status).toBe(200);
    expect(supabase.rpc).toHaveBeenCalledWith('bbai_apply_site_billing_event', expect.objectContaining({
      p_site_id: 'site_periods',
      p_plan_id: 'pro',
      p_stripe_subscription_id: 'sub_periods',
      p_current_period_start: '2026-10-02T13:51:27.000Z',
      p_current_period_end: '2026-11-02T13:51:27.000Z'
    }));
    expect(supabase.siteSubUpdates[0]).toEqual(expect.objectContaining({
      current_period_start: '2026-10-02T13:51:27.000Z',
      current_period_end: '2026-11-02T13:51:27.000Z'
    }));
  });

  test('an event with no period anywhere does not blank the stored period', async () => {
    const supabase = createSupabaseStub();
    verifyWebhookSignature.mockReturnValue(dahliaSubscriptionEvent({ status: 'past_due', itemPeriod: false }));

    const res = await send(createApp(supabase));

    expect(res.status).toBe(200);
    expect(supabase.siteSubUpdates.length).toBeGreaterThan(0);
    for (const update of supabase.siteSubUpdates) {
      expect(update).not.toHaveProperty('current_period_start');
      expect(update).not.toHaveProperty('current_period_end');
    }
    expect(supabase.siteSub.current_period_end).toBe('2026-11-02T13:51:27.000Z');
  });
});
