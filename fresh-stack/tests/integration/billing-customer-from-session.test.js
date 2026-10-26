/**
 * Billing routes take the Stripe customer and account identity from the
 * signed-in caller, not from the request body. Billing logs never carry a
 * full cus_ / sub_ / cs_ id. Test addresses use @qa.oppti.dev only.
 */
const express = require('express');
const request = require('supertest');

const { createBillingRouter } = require('../../routes/billing');
const logger = require('../../lib/logger');
const { createTableMock } = require('../helpers/tableMock');

const OWN = { id: 'acct-own', license_key: 'lic-own', email: 'own@qa.oppti.dev', plan: 'pro', status: 'active', stripe_customer_id: 'cus_OwnCustomer0001', stripe_subscription_id: 'sub_OwnSubscription01' };
const OTHER_CUSTOMER = 'cus_OtherCustomer9999';
const NO_STRIPE = { id: 'acct-free', license_key: 'lic-free', email: 'free@qa.oppti.dev', plan: 'free', status: 'active' };

function buildSupabase(extra = {}) {
  return createTableMock({
    licenses: [OWN, NO_STRIPE],
    sites: [
      { id: 'site-own', site_hash: 'hash-own', wp_install_uuid: 'hash-own', license_key: 'lic-own', owner_user_id: 'acct-own', status: 'active', site_url: 'https://own.example' },
      { id: 'site-own-2', site_hash: 'hash-own-2', license_key: 'lic-own', owner_user_id: 'acct-own', status: 'active', site_url: 'https://own-two.example' },
      { id: 'site-other', site_hash: 'hash-other', license_key: 'lic-other', owner_user_id: 'acct-other', status: 'active', site_url: 'https://other.example' }
    ],
    site_memberships: [],
    site_subscriptions: [
      { id: 'ss-own-2', site_id: 'site-own-2', status: 'active', plan_id: 'pro', stripe_customer_id: 'cus_OwnSecondCust02', stripe_subscription_id: 'sub_OwnSecondSub002' },
      { id: 'ss-other', site_id: 'site-other', status: 'active', plan_id: 'agency', stripe_customer_id: OTHER_CUSTOMER, stripe_subscription_id: 'sub_OtherSubscript99' }
    ],
    ...extra
  });
}

function buildStripe() {
  return {
    billingPortal: { sessions: { create: jest.fn().mockResolvedValue({ url: 'https://billing.stripe.test/p/1' }) } },
    checkout: {
      sessions: {
        create: jest.fn().mockResolvedValue({ id: 'cs_test_SessionABCDEF123', url: 'https://checkout.stripe.test/c/1' }),
        retrieve: jest.fn()
      }
    }
  };
}

function buildApp({ supabase = buildSupabase(), stripe = buildStripe(), license = null, user = null, authMethod = null } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.license = license; req.user = user; req.authMethod = authMethod || (user ? 'jwt' : license ? 'license' : undefined); next(); });
  app.use('/billing', createBillingRouter({
    supabase,
    getStripe: () => stripe,
    priceIds: { starter: 'price_starter', pro: 'price_pro', agency: 'price_agency', credits: 'price_credits' }
  }));
  return { app, stripe };
}

let spies;
beforeEach(() => {
  spies = ['info', 'warn', 'error', 'debug'].map((level) => jest.spyOn(logger, level).mockImplementation(() => {}));
});
afterEach(() => jest.restoreAllMocks());
const logText = () => JSON.stringify(spies.map((spy) => spy.mock.calls));
const FULL_STRIPE_ID = /\b(cus|sub|cs)_(?:(?:live|test)_)?[A-Za-z0-9]{5,}/;

function portal({ license, body = { returnUrl: 'https://own.example/wp-admin/admin.php?page=bbai' }, supabase } = {}) {
  const { app, stripe } = buildApp({ license, supabase });
  return request(app)
    .post('/billing/portal')
    .set('X-Site-Key', 'hash-own')
    .send(body)
    .then((res) => ({ res, stripe }));
}

describe('POST /billing/portal', () => {
  test('own customer: plugin call shape ({ returnUrl } + X-Site-Key) opens the caller\'s portal', async () => {
    const { res, stripe } = await portal({ license: OWN });
    expect(res.status).toBe(200);
    expect(stripe.billingPortal.sessions.create).toHaveBeenCalledWith({
      customer: 'cus_OwnCustomer0001',
      return_url: 'https://own.example/wp-admin/admin.php?page=bbai'
    });
    expect(res.body).toMatchObject({ success: true, customerId: 'cus_***0001', source: 'account' });
    expect(JSON.stringify(res.body)).not.toMatch(FULL_STRIPE_ID);
  });

  test('Alt Text legacy shape ({ return_url }) and Titles shape ({}) still work', async () => {
    let result = await portal({ license: OWN, body: { return_url: 'https://own.example/wp-admin/' } });
    expect(result.res.status).toBe(200);
    result = await portal({ license: OWN, body: {} });
    expect(result.res.status).toBe(200);
    expect(result.stripe.billingPortal.sessions.create.mock.calls[0][0].customer).toBe('cus_OwnCustomer0001');
  });

  test('another account\'s customer id in the body is refused with 403 and no portal session', async () => {
    const { res, stripe } = await portal({ license: OWN, body: { customerId: OTHER_CUSTOMER } });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('CUSTOMER_NOT_OWNED');
    expect(stripe.billingPortal.sessions.create).not.toHaveBeenCalled();
  });

  test('another account\'s customer id is refused even when the caller has no customer of its own', async () => {
    const { res, stripe } = await portal({ license: NO_STRIPE, body: { customerId: OTHER_CUSTOMER } });
    expect(res.status).toBe(403);
    expect(stripe.billingPortal.sessions.create).not.toHaveBeenCalled();
  });

  test('an unknown customer id is refused', async () => {
    const { res, stripe } = await portal({ license: OWN, body: { customerId: 'cus_DoesNotExist0000' } });
    expect(res.status).toBe(403);
    expect(stripe.billingPortal.sessions.create).not.toHaveBeenCalled();
  });

  test('the caller\'s own customer id in the body is accepted (account row or own site subscription)', async () => {
    let result = await portal({ license: OWN, body: { customerId: 'cus_OwnCustomer0001' } });
    expect(result.res.status).toBe(200);
    expect(result.stripe.billingPortal.sessions.create.mock.calls[0][0].customer).toBe('cus_OwnCustomer0001');

    result = await portal({ license: OWN, body: { customerId: 'cus_OwnSecondCust02' } });
    expect(result.res.status).toBe(200);
    expect(result.stripe.billingPortal.sessions.create.mock.calls[0][0].customer).toBe('cus_OwnSecondCust02');
  });

  test('site membership alone does not make another account\'s customer usable', async () => {
    const supabase = buildSupabase({ site_memberships: [{ site_id: 'site-other', user_id: 'acct-free', role: 'member' }] });
    const { res, stripe } = await portal({ license: NO_STRIPE, body: { customerId: OTHER_CUSTOMER }, supabase });
    expect(res.status).toBe(403);
    expect(stripe.billingPortal.sessions.create).not.toHaveBeenCalled();
  });

  test('no customer on the account gives a clear 409 billing_not_linked', async () => {
    const { res, stripe } = await portal({ license: NO_STRIPE });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('billing_not_linked');
    expect(stripe.billingPortal.sessions.create).not.toHaveBeenCalled();
  });

  test('no signed-in account gives 401, even with a customer id in the body', async () => {
    const { res, stripe } = await portal({ license: null, body: { customerId: OTHER_CUSTOMER } });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ code: 'SIGN_IN_REQUIRED', message: 'Sign in to manage billing.' });
    expect(stripe.billingPortal.sessions.create).not.toHaveBeenCalled();
  });

  test('portal logs never carry a full Stripe id', async () => {
    await portal({ license: OWN, body: { customerId: OTHER_CUSTOMER } });
    await portal({ license: NO_STRIPE });
    const { stripe, res } = await (async () => {
      const s = buildStripe();
      s.billingPortal.sessions.create.mockRejectedValue(new Error(`No such customer: '${OWN.stripe_customer_id}'`));
      const { app } = buildApp({ license: OWN, stripe: s });
      const r = await request(app).post('/billing/portal').set('X-Site-Key', 'hash-own').send({});
      return { stripe: s, res: r };
    })();
    expect(res.status).toBe(500);
    expect(stripe.billingPortal.sessions.create).toHaveBeenCalled();
    expect(logText()).not.toMatch(FULL_STRIPE_ID);
  });
});

describe('POST /billing/checkout identity metadata', () => {
  const saved = process.env.CHECKOUT_CREDITS_RATE_LIMIT_PER_15_MIN;
  beforeAll(() => { process.env.CHECKOUT_CREDITS_RATE_LIMIT_PER_15_MIN = '1000'; });
  afterAll(() => {
    if (saved === undefined) delete process.env.CHECKOUT_CREDITS_RATE_LIMIT_PER_15_MIN;
    else process.env.CHECKOUT_CREDITS_RATE_LIMIT_PER_15_MIN = saved;
  });

  const OVERRIDES = {
    account_id: 'acct-other',
    user_id: 'acct-other',
    license_key: 'lic-other',
    site_id: 'site-other',
    site_hash: 'hash-other',
    site_install_id: 'hash-other',
    email: 'other@qa.oppti.dev'
  };

  test('signed-in caller: body identity fields never reach Stripe metadata', async () => {
    const { app, stripe } = buildApp({ license: NO_STRIPE });
    const res = await request(app)
      .post('/billing/checkout')
      .set('X-Site-Key', 'hash-unregistered')
      .send({ priceId: 'price_credits', ...OVERRIDES });
    expect(res.status).toBe(200);
    const { metadata } = stripe.checkout.sessions.create.mock.calls[0][0];
    expect(metadata.account_id).toBe('acct-free');
    expect(metadata.user_id).toBe('acct-free');
    expect(metadata.license_key).toBe('lic-free');
    expect(metadata.email).toBe('free@qa.oppti.dev');
    expect(metadata.site_id).not.toBe('site-other');
    expect(metadata.site_hash).not.toBe('hash-other');
    expect(JSON.stringify(metadata)).not.toMatch(/acct-other|lic-other|site-other|hash-other|other@qa/);
  });

  test('server-to-server call with no account still passes body identity through', async () => {
    const { app, stripe } = buildApp({ license: null });
    const res = await request(app)
      .post('/billing/checkout')
      .set('X-Site-Key', 'hash-s2s')
      .send({ priceId: 'price_credits', account_id: 'acct-s2s', user_id: 'acct-s2s', email: 's2s@qa.oppti.dev' });
    expect(res.status).toBe(200);
    const { metadata } = stripe.checkout.sessions.create.mock.calls[0][0];
    expect(metadata).toMatchObject({ account_id: 'acct-s2s', user_id: 'acct-s2s', email: 's2s@qa.oppti.dev' });
  });

  test('checkout logs carry no full session or customer id', async () => {
    const { app } = buildApp({ license: OWN });
    await request(app).post('/billing/checkout').set('X-Site-Key', 'hash-own').send({ priceId: 'price_credits' });
    expect(logText()).toContain('checkout_outcome');
    expect(logText()).not.toMatch(FULL_STRIPE_ID);
  });
});

describe('POST /billing/checkout/email-link', () => {
  test('logs carry no full session id', async () => {
    const { app, stripe } = buildApp({ license: OWN });
    stripe.checkout.sessions.retrieve.mockResolvedValue({ id: 'cs_test_SessionABCDEF123', client_reference_id: 'acct-someone-else', status: 'open', url: 'https://checkout.stripe.test/c/1' });
    const res = await request(app).post('/billing/checkout/email-link').send({ session_id: 'cs_test_SessionABCDEF123' });
    expect([403, 503]).toContain(res.status);
    expect(logText()).toContain('checkout_link_email');
    expect(logText()).not.toMatch(FULL_STRIPE_ID);
  });
});
