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
const { trackPaymentSucceeded, trackPlanUpgraded } = require('../../../src/services/loops');
const { createBillingWebhookHandler } = require('../../routes/billing');

const PRICE_IDS = { starter: 'price_starter', pro: 'price_pro', agency: 'price_agency', credits: 'price_credits' };
const CREDIT_GRANTS = { credits: 100 };
const PERIOD = { start: 1790949087, end: 1793627487 }; // 2 Oct -> 2 Nov 2026 13:51:27Z

// Supabase stub: one account with one site, an RPC simulator that is idempotent on
// p_stripe_event_id (like usage_events.idempotency_key) and keeps a credit ledger.
function createSupabaseStub({ accountPlan = 'starter' } = {}) {
  const account = {
    id: 'acct_f2', email: 'f2@qa.oppti.dev', license_key: 'lic_f2', stripe_customer_id: 'cus_f2',
    stripe_subscription_id: 'sub_f2', plan: accountPlan, billing_cycle: 'monthly'
  };
  const site = { id: 'site_f2', site_hash: 'hash_f2', license_key: 'lic_f2' };
  const siteSub = {
    id: 'site_sub_f2', site_id: 'site_f2', plan_id: accountPlan, stripe_customer_id: 'cus_f2',
    stripe_subscription_id: 'sub_f2', status: 'active', current_period_start: null, current_period_end: null
  };
  const seenEventIds = new Set();
  const state = { purchasedCredits: 0, licenseUpdates: [], siteSubUpdates: [], rpcCalls: [] };
  const one = (rows) => ({
    maybeSingle: async () => ({ data: rows[0] || null, error: null }),
    single: async () => ({ data: rows[0] || null, error: null }),
    then: (resolve, reject) => Promise.resolve({ data: rows, error: null }).then(resolve, reject)
  });
  return {
    state,
    account,
    rpc: jest.fn(async (name, payload) => {
      state.rpcCalls.push(payload);
      if (seenEventIds.has(payload.p_stripe_event_id)) {
        return { data: { ok: true, duplicate: true }, error: null };
      }
      seenEventIds.add(payload.p_stripe_event_id);
      if (payload.p_plan_id === 'credits') {
        state.purchasedCredits += CREDIT_GRANTS.credits;
      } else {
        Object.assign(siteSub, { plan_id: payload.p_plan_id, billing_interval: payload.p_billing_interval });
      }
      return { data: { ok: true, duplicate: false, site_subscription_id: siteSub.id }, error: null };
    }),
    from(table) {
      if (table === 'licenses') {
        return {
          select: () => ({
            eq: (c, v) => one(account[c] === v ? [account] : []),
            ilike: () => ({ limit: async () => ({ data: [], error: null }) })
          }),
          update: (payload) => ({
            eq: () => {
              state.licenseUpdates.push(payload);
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
                  state.siteSubUpdates.push(payload);
                  if (siteSub[c] === v) Object.assign(siteSub, payload);
                  return { data: siteSub[c] === v ? { ...siteSub } : null, error: null };
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

function createApp(supabase, stripeClient = null) {
  const app = express();
  app.post('/billing/webhook', express.raw({ type: 'application/json' }), createBillingWebhookHandler({
    supabase, getStripe: () => stripeClient, webhookSecret: 'whsec_test', priceIds: PRICE_IDS
  }));
  return app;
}

const send = (app) => request(app).post('/billing/webhook')
  .set('Stripe-Signature', 'sig_test').set('Content-Type', 'application/json').send('{}');

// Dahlia (2026-03-25) invoice line: no price/proration at top level.
const dahliaLine = ({ priceId, amount, proration, price }) => ({
  amount,
  period: PERIOD,
  pricing: { type: 'price_details', price_details: { price: price || priceId, product: `prod_${priceId}` } },
  parent: {
    type: 'subscription_item_details',
    subscription_item_details: { subscription: 'sub_f2', subscription_item: 'si_f2', proration }
  }
});

// Legacy (2022-11-15) invoice line.
const legacyLine = ({ priceId, amount, proration }) => ({
  amount,
  proration,
  period: PERIOD,
  price: { id: priceId, product: `prod_${priceId}`, recurring: { interval: 'month' } }
});

// Starter -> Growth upgrade: first line is the negative "Unused time on Starter" credit.
// Subscription metadata still says plan=starter (written at checkout).
function upgradeInvoiceEvent(shape) {
  const lines = shape === 'dahlia'
    ? [
      dahliaLine({ priceId: 'price_starter', amount: -310, proration: true }),
      dahliaLine({ priceId: 'price_pro', amount: 806, proration: true })
    ]
    : [
      legacyLine({ priceId: 'price_starter', amount: -310, proration: true }),
      legacyLine({ priceId: 'price_pro', amount: 806, proration: true })
    ];
  const invoice = {
    id: `in_upgrade_${shape}`,
    amount_paid: 496,
    currency: 'gbp',
    customer: 'cus_f2',
    billing_reason: 'subscription_update',
    livemode: false,
    metadata: {},
    lines: { data: lines }
  };
  if (shape === 'dahlia') {
    invoice.parent = {
      type: 'subscription_details',
      subscription_details: { subscription: 'sub_f2', metadata: { account_id: 'acct_f2', plan: 'starter' } }
    };
  } else {
    invoice.subscription = 'sub_f2';
    invoice.subscription_details = { metadata: { account_id: 'acct_f2', plan: 'starter' } };
  }
  return { id: `evt_upgrade_${shape}`, type: 'invoice.paid', data: { object: invoice } };
}

describe('dahlia follow-ups', () => {
  const originalKey = process.env.STRIPE_SECRET_KEY;
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.STRIPE_SECRET_KEY = 'sk_test_mock';
  });
  afterAll(() => { process.env.STRIPE_SECRET_KEY = originalKey; });

  test.each(['dahlia', 'legacy'])('P1: Starter->Growth proration invoice (%s shape) resolves Growth, not the credit line', async (shape) => {
    const supabase = createSupabaseStub({ accountPlan: 'starter' });
    verifyWebhookSignature.mockReturnValue(upgradeInvoiceEvent(shape));

    const res = await send(createApp(supabase));

    expect(res.status).toBe(200);
    expect(supabase.rpc).toHaveBeenCalledWith('bbai_apply_site_billing_event', expect.objectContaining({
      p_site_id: 'site_f2',
      p_plan_id: 'pro',
      p_purchase_type: 'upgrade',
      p_stripe_subscription_id: 'sub_f2',
      p_current_period_end: '2026-11-02T13:51:27.000Z'
    }));
    expect(supabase.state.licenseUpdates).toEqual(expect.arrayContaining([
      expect.objectContaining({ plan: 'pro' })
    ]));
    expect(supabase.account.plan).toBe('pro');
  });

  test('P1: subscription price from Stripe wins over a stale plan in subscription metadata', async () => {
    const supabase = createSupabaseStub({ accountPlan: 'starter' });
    const stripeClient = {
      subscriptions: {
        retrieve: jest.fn().mockResolvedValue({
          id: 'sub_f2',
          metadata: { account_id: 'acct_f2', plan: 'starter' },
          items: { data: [{ price: { id: 'price_pro', product: 'prod_pro', recurring: { interval: 'month' } } }] }
        })
      }
    };
    const event = upgradeInvoiceEvent('dahlia');
    event.data.object.lines.data.reverse(); // order must not matter
    verifyWebhookSignature.mockReturnValue(event);

    const res = await send(createApp(supabase, stripeClient));

    expect(res.status).toBe(200);
    expect(stripeClient.subscriptions.retrieve).toHaveBeenCalledWith('sub_f2');
    expect(supabase.rpc).toHaveBeenCalledWith('bbai_apply_site_billing_event', expect.objectContaining({ p_plan_id: 'pro' }));
  });

  test('P1: customer.subscription.updated after a portal upgrade uses the item price, not stale metadata', async () => {
    const supabase = createSupabaseStub({ accountPlan: 'starter' });
    verifyWebhookSignature.mockReturnValue({
      id: 'evt_sub_upgraded',
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: 'sub_f2', status: 'active', customer: 'cus_f2', livemode: false, cancel_at_period_end: false,
          metadata: { account_id: 'acct_f2', plan: 'starter' },
          items: { data: [{ current_period_start: PERIOD.start, current_period_end: PERIOD.end, price: { id: 'price_pro', recurring: { interval: 'month' } } }] }
        }
      }
    });

    const res = await send(createApp(supabase));

    expect(res.status).toBe(200);
    expect(supabase.rpc).toHaveBeenCalledWith('bbai_apply_site_billing_event', expect.objectContaining({
      p_plan_id: 'pro',
      p_current_period_end: '2026-11-02T13:51:27.000Z'
    }));
  });

  test('P1-b: customer.subscription.deleted in dahlia shape keeps the item-level period', async () => {
    const supabase = createSupabaseStub({ accountPlan: 'pro' });
    verifyWebhookSignature.mockReturnValue({
      id: 'evt_sub_deleted',
      type: 'customer.subscription.deleted',
      data: {
        object: {
          id: 'sub_f2', status: 'canceled', customer: 'cus_f2', livemode: false, canceled_at: PERIOD.end,
          metadata: { account_id: 'acct_f2' },
          items: { data: [{ current_period_start: PERIOD.start, current_period_end: PERIOD.end, price: { id: 'price_pro' } }] }
        }
      }
    });

    const res = await send(createApp(supabase));

    expect(res.status).toBe(200);
    expect(supabase.state.siteSubUpdates[0]).toEqual(expect.objectContaining({
      status: 'canceled',
      current_period_start: '2026-10-02T13:51:27.000Z',
      current_period_end: '2026-11-02T13:51:27.000Z'
    }));
    expect(supabase.account.plan).toBe('free');
  });

  test('P2: billing interval comes from the subscription price when dahlia lines carry none', async () => {
    const supabase = createSupabaseStub({ accountPlan: 'free' });
    const stripeClient = {
      subscriptions: {
        retrieve: jest.fn().mockResolvedValue({
          id: 'sub_f2', metadata: { account_id: 'acct_f2' },
          items: { data: [{ price: { id: 'price_pro', product: 'prod_pro', recurring: { interval: 'year' } } }] }
        })
      }
    };
    verifyWebhookSignature.mockReturnValue({
      id: 'evt_yearly',
      type: 'invoice.paid',
      data: {
        object: {
          id: 'in_yearly', amount_paid: 12990, currency: 'gbp', customer: 'cus_f2', billing_reason: 'subscription_create',
          livemode: false, metadata: {},
          parent: { type: 'subscription_details', subscription_details: { subscription: 'sub_f2', metadata: { account_id: 'acct_f2' } } },
          lines: { data: [dahliaLine({ priceId: 'price_pro', amount: 12990, proration: false })] }
        }
      }
    });

    const res = await send(createApp(supabase, stripeClient));

    expect(res.status).toBe(200);
    expect(supabase.rpc).toHaveBeenCalledWith('bbai_apply_site_billing_event', expect.objectContaining({
      p_plan_id: 'pro',
      p_billing_interval: 'year'
    }));
  });

  test('P2: billing interval is read from an expanded pricing.price_details.price', async () => {
    const supabase = createSupabaseStub({ accountPlan: 'free' });
    verifyWebhookSignature.mockReturnValue({
      id: 'evt_yearly_expanded',
      type: 'invoice.paid',
      data: {
        object: {
          id: 'in_yearly_expanded', amount_paid: 12990, currency: 'gbp', customer: 'cus_f2',
          billing_reason: 'subscription_create', livemode: false, metadata: {},
          parent: { type: 'subscription_details', subscription_details: { subscription: 'sub_f2', metadata: { account_id: 'acct_f2' } } },
          lines: {
            data: [dahliaLine({
              priceId: 'price_pro',
              amount: 12990,
              proration: false,
              price: { id: 'price_pro', product: 'prod_pro', recurring: { interval: 'year' } }
            })]
          }
        }
      }
    });

    const res = await send(createApp(supabase));

    expect(res.status).toBe(200);
    expect(supabase.rpc).toHaveBeenCalledWith('bbai_apply_site_billing_event', expect.objectContaining({
      p_plan_id: 'pro',
      p_billing_interval: 'year'
    }));
  });

  test('P2: invoice.paid + invoice.payment_succeeded for one credit-pack invoice credit once and share one Loops key', async () => {
    const supabase = createSupabaseStub({ accountPlan: 'pro' });
    const packInvoice = {
      id: 'in_pack', amount_paid: 999, currency: 'gbp', customer: 'cus_f2', billing_reason: 'manual',
      livemode: false, metadata: { account_id: 'acct_f2', plan: 'credits' },
      lines: { data: [{ amount: 999, period: PERIOD, pricing: { type: 'price_details', price_details: { price: 'price_credits' } } }] }
    };
    const app = createApp(supabase);

    verifyWebhookSignature.mockReturnValueOnce({ id: 'evt_pack_paid', type: 'invoice.paid', data: { object: packInvoice } });
    await send(app);
    verifyWebhookSignature.mockReturnValueOnce({ id: 'evt_pack_succeeded', type: 'invoice.payment_succeeded', data: { object: packInvoice } });
    await send(app);

    expect(supabase.rpc).toHaveBeenCalledTimes(2);
    const rpcKeys = supabase.state.rpcCalls.map((call) => call.p_stripe_event_id);
    expect(new Set(rpcKeys)).toEqual(new Set(['invoice_paid:in_pack']));
    expect(supabase.state.purchasedCredits).toBe(100);

    const loopsKeys = trackPaymentSucceeded.mock.calls.map(([args]) => args.stripeEventId);
    expect(loopsKeys).toEqual(['invoice_paid:in_pack', 'invoice_paid:in_pack']);
  });

  test('P2: both invoice event types for one upgrade send Loops plan_upgraded with one idempotency key', async () => {
    const supabase = createSupabaseStub({ accountPlan: 'starter' });
    const app = createApp(supabase);
    const event = upgradeInvoiceEvent('dahlia');

    verifyWebhookSignature.mockReturnValueOnce({ ...event, id: 'evt_a', type: 'invoice.paid' });
    await send(app);
    verifyWebhookSignature.mockReturnValueOnce({ ...event, id: 'evt_b', type: 'invoice.payment_succeeded' });
    await send(app);

    const keys = new Set(trackPlanUpgraded.mock.calls.map(([args]) => args.stripeEventId));
    expect(keys).toEqual(new Set(['invoice_paid:in_upgrade_dahlia']));
  });
});
