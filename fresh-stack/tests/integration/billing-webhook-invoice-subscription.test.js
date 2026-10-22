const express = require('express');
const request = require('supertest');

jest.mock('../../lib/stripe', () => ({
  verifyWebhookSignature: jest.fn()
}));

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

// Minimal Supabase stub: one free account with exactly one site, no Stripe ids linked yet.
function createSupabaseStub() {
  const account = {
    id: 'acct_invoice_sub',
    email: 'invoice-sub@qa.oppti.dev',
    license_key: 'lic_invoice_sub',
    stripe_customer_id: null,
    stripe_subscription_id: null,
    plan: 'free',
    billing_cycle: 'monthly'
  };
  const site = { id: 'site_invoice_sub', site_hash: 'hash_invoice_sub', license_key: 'lic_invoice_sub' };
  const licenseUpdates = [];
  const pick = (rows, column, value) => rows.filter((row) => row[column] === value);
  const thenable = (data) => ({
    maybeSingle: async () => ({ data: data[0] || null, error: null }),
    single: async () => ({ data: data[0] || null, error: null }),
    then: (resolve, reject) => Promise.resolve({ data, error: null }).then(resolve, reject)
  });

  return {
    licenseUpdates,
    rpc: jest.fn(async (name, payload) => ({
      data: { ok: true, site_subscription_id: 'site_sub_1', plan_id: payload.p_plan_id },
      error: null
    })),
    from(table) {
      if (table === 'licenses') {
        return {
          select: () => ({
            eq: (column, value) => thenable(pick([account], column, value)),
            ilike: (column, pattern) => ({
              limit: async () => ({
                data: [account].filter((row) => String(row[column]).toLowerCase() === String(pattern).replace(/\\(.)/g, '$1').toLowerCase()),
                error: null
              })
            })
          }),
          update: (payload) => ({
            eq: (column, value) => {
              licenseUpdates.push(payload);
              Object.assign(account, payload);
              const result = { data: { ...account }, error: null };
              return {
                select: () => ({ single: async () => result }),
                then: (resolve, reject) => Promise.resolve(result).then(resolve, reject)
              };
            }
          })
        };
      }
      if (table === 'sites') {
        return {
          select: () => ({ eq: (column, value) => thenable(pick([site], column, value)) }),
          update: () => ({ eq: () => thenable([]) })
        };
      }
      if (table === 'site_subscriptions') {
        const chain = {
          eq: () => chain,
          order: () => chain,
          limit: async () => ({ data: [], error: null }),
          maybeSingle: async () => ({ data: null, error: null })
        };
        return { select: () => chain };
      }
      throw new Error(`Unexpected table: ${table}`);
    }
  };
}

function createApp(supabase) {
  const app = express();
  app.post(
    '/billing/webhook',
    express.raw({ type: 'application/json' }),
    createBillingWebhookHandler({
      supabase,
      getStripe: () => null,
      webhookSecret: 'whsec_test',
      priceIds: { starter: 'price_starter', pro: 'price_pro', agency: 'price_agency', credits: 'price_credits' }
    })
  );
  return app;
}

// invoice.paid as Stripe sends it on API versions >= 2025-03-31 (basil/dahlia):
// no invoice.subscription and no line.price; the ids live under parent / pricing.
function dashboardSubscriptionInvoice({ subscriptionMetadata = {}, customerEmail = null } = {}) {
  return {
    id: 'evt_invoice_sub_paid',
    type: 'invoice.paid',
    data: {
      object: {
        id: 'in_invoice_sub',
        amount_paid: 499,
        currency: 'gbp',
        customer: 'cus_new_invoice_sub',
        customer_email: customerEmail,
        billing_reason: 'subscription_create',
        collection_method: 'send_invoice',
        livemode: false,
        metadata: {},
        parent: {
          type: 'subscription_details',
          subscription_details: { subscription: 'sub_invoice_sub', metadata: subscriptionMetadata }
        },
        lines: {
          data: [{
            period: { start: 1792627200, end: 1795305600 },
            pricing: {
              type: 'price_details',
              price_details: { price: 'price_starter', product: 'prod_starter' }
            },
            parent: {
              type: 'subscription_item_details',
              subscription_item_details: { subscription: 'sub_invoice_sub', subscription_item: 'si_1' }
            }
          }]
        }
      }
    }
  };
}

async function send(app) {
  return request(app)
    .post('/billing/webhook')
    .set('Stripe-Signature', 'sig_test')
    .set('Content-Type', 'application/json')
    .send(JSON.stringify({ id: 'evt_invoice_sub_paid' }));
}

describe('invoice.paid for a dashboard-created (send_invoice) subscription', () => {
  beforeEach(() => jest.clearAllMocks());

  test('upgrades to Starter from the price id when the subscription carries only account_id', async () => {
    const supabase = createSupabaseStub();
    verifyWebhookSignature.mockReturnValue(dashboardSubscriptionInvoice({
      subscriptionMetadata: { account_id: 'acct_invoice_sub' }
    }));

    const res = await send(createApp(supabase));

    expect(res.status).toBe(200);
    expect(supabase.rpc).toHaveBeenCalledWith('bbai_apply_site_billing_event', expect.objectContaining({
      p_site_id: 'site_invoice_sub',
      p_plan_id: 'starter',
      p_purchase_type: 'new_purchase',
      p_stripe_customer_id: 'cus_new_invoice_sub',
      p_stripe_subscription_id: 'sub_invoice_sub'
    }));
    expect(supabase.licenseUpdates).toEqual(expect.arrayContaining([
      expect.objectContaining({ plan: 'starter', status: 'active', stripe_subscription_id: 'sub_invoice_sub' })
    ]));
  });

  test('upgrades to Starter with no metadata when the invoice email matches the account', async () => {
    const supabase = createSupabaseStub();
    verifyWebhookSignature.mockReturnValue(dashboardSubscriptionInvoice({
      customerEmail: 'Invoice-Sub@qa.oppti.dev'
    }));

    const res = await send(createApp(supabase));

    expect(res.status).toBe(200);
    expect(supabase.rpc).toHaveBeenCalledWith('bbai_apply_site_billing_event', expect.objectContaining({
      p_site_id: 'site_invoice_sub',
      p_plan_id: 'starter',
      p_stripe_subscription_id: 'sub_invoice_sub'
    }));
  });

  test('explicit plan metadata still works (current workaround path)', async () => {
    const supabase = createSupabaseStub();
    verifyWebhookSignature.mockReturnValue(dashboardSubscriptionInvoice({
      subscriptionMetadata: { account_id: 'acct_invoice_sub', plan: 'starter' }
    }));

    const res = await send(createApp(supabase));

    expect(res.status).toBe(200);
    expect(supabase.rpc).toHaveBeenCalledWith('bbai_apply_site_billing_event', expect.objectContaining({
      p_site_id: 'site_invoice_sub',
      p_plan_id: 'starter'
    }));
  });
});
