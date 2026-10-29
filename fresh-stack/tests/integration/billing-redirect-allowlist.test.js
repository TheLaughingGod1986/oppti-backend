/**
 * /billing/checkout and /billing/portal: caller successUrl / cancelUrl /
 * returnUrl allowlist (registered site hosts + oppti.dev), log-only by default,
 * BILLING_REDIRECT_ALLOWLIST_ENFORCE switches unlisted URLs to oppti.dev pages.
 * Test addresses use @qa.oppti.dev only.
 */
const express = require('express');
const request = require('supertest');

const { createBillingRouter } = require('../../routes/billing');
const logger = require('../../lib/logger');
const { createTableMock } = require('../helpers/tableMock');

const ACCOUNT = { id: 'acct-1', license_key: 'lic-1', email: 'buyer@qa.oppti.dev', plan: 'free', status: 'active' };
const LONELY_ACCOUNT = { id: 'acct-2', license_key: 'lic-2', email: 'lonely@qa.oppti.dev', plan: 'free', status: 'active' };

function buildSupabase() {
  return createTableMock({
    licenses: [ACCOUNT, LONELY_ACCOUNT],
    sites: [
      { id: 'site-1', site_hash: 'site-hash-1', wp_install_uuid: 'site-hash-1', license_key: 'lic-1', owner_user_id: 'acct-1', status: 'active', site_url: 'https://www.shop-one.example' }
    ],
    site_memberships: [],
    site_subscriptions: []
  });
}

function buildStripe() {
  return {
    checkout: { sessions: { create: jest.fn().mockResolvedValue({ id: 'cs_test_1', url: 'https://checkout.stripe.test/c/1' }) } },
    billingPortal: { sessions: { create: jest.fn().mockResolvedValue({ url: 'https://billing.stripe.test/p/1' }) } }
  };
}

function buildApp({ supabase, stripe, account }) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.license = account; req.user = null; req.authMethod = account ? 'license' : undefined; next(); });
  app.use('/billing', createBillingRouter({
    supabase,
    getStripe: () => stripe,
    priceIds: { starter: 'price_starter', pro: 'price_pro', agency: 'price_agency', credits: 'price_credits' }
  }));
  return app;
}

let warnSpy;
const savedFlag = process.env.BILLING_REDIRECT_ALLOWLIST_ENFORCE;
const savedLimit = process.env.CHECKOUT_CREDITS_RATE_LIMIT_PER_15_MIN;
beforeAll(() => { process.env.CHECKOUT_CREDITS_RATE_LIMIT_PER_15_MIN = '1000'; });
afterAll(() => {
  if (savedLimit === undefined) delete process.env.CHECKOUT_CREDITS_RATE_LIMIT_PER_15_MIN;
  else process.env.CHECKOUT_CREDITS_RATE_LIMIT_PER_15_MIN = savedLimit;
});
beforeEach(() => {
  delete process.env.BILLING_REDIRECT_ALLOWLIST_ENFORCE;
  warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {});
  jest.spyOn(logger, 'info').mockImplementation(() => {});
});
afterEach(() => {
  jest.restoreAllMocks();
  if (savedFlag === undefined) delete process.env.BILLING_REDIRECT_ALLOWLIST_ENFORCE;
  else process.env.BILLING_REDIRECT_ALLOWLIST_ENFORCE = savedFlag;
});

const redirectWarnings = () => warnSpy.mock.calls.filter(([message]) => message === '[billing] redirect_url_not_allowlisted');

async function checkout({ account = ACCOUNT, successUrl, cancelUrl, siteKey = 'site-hash-1' } = {}) {
  const stripe = buildStripe();
  const res = await request(buildApp({ supabase: buildSupabase(), stripe, account }))
    .post('/billing/checkout')
    .set('X-Site-Key', siteKey)
    .send({ priceId: 'price_credits', successUrl, cancelUrl });
  return { res, payload: stripe.checkout.sessions.create.mock.calls[0]?.[0] };
}

const HOSTILE_SUCCESS = 'https://attacker.test/thanks?ref=victim%40qa.oppti.dev&k=secretvalue';
const HOSTILE_CANCEL = 'https://attacker.test/cancel';

describe('POST /billing/checkout redirect allowlist', () => {
  test.each([
    ['listed site (www registration, bare URL)', 'https://shop-one.example/wp-admin/admin.php?page=bbai&checkout=success'],
    ['www form of the listed site', 'https://www.shop-one.example/wp-admin/'],
    ['subdomain of the listed site', 'https://store.shop-one.example/thanks'],
    ['oppti.dev', 'https://oppti.dev/billing/success?session_id={CHECKOUT_SESSION_ID}']
  ])('flag on, %s: used as sent, no warning', async (_label, url) => {
    process.env.BILLING_REDIRECT_ALLOWLIST_ENFORCE = 'true';
    const { res, payload } = await checkout({ successUrl: url, cancelUrl: url });
    expect(res.status).toBe(200);
    expect(payload.success_url).toBe(url);
    expect(payload.cancel_url).toBe(url);
    expect(redirectWarnings()).toHaveLength(0);
  });

  test('flag off (default): hostile URLs used as before, warnings carry the host only', async () => {
    const { res, payload } = await checkout({ successUrl: HOSTILE_SUCCESS, cancelUrl: HOSTILE_CANCEL });
    expect(res.status).toBe(200);
    expect(payload.success_url).toBe(HOSTILE_SUCCESS);
    expect(payload.cancel_url).toBe(HOSTILE_CANCEL);
    const warnings = redirectWarnings();
    expect(warnings.map(([, f]) => f.field).sort()).toEqual(['cancelUrl', 'successUrl']);
    for (const [, fields] of warnings) {
      expect(fields).toMatchObject({ host: 'attacker.test', reason: 'host_not_registered', enforced: false, route: 'checkout', account_id: 'acct-1' });
    }
    const text = JSON.stringify(warnings);
    expect(text).not.toMatch(/thanks|ref=|victim|secretvalue|buyer@|qa\.oppti\.dev/);
  });

  test('flag on: hostile URLs fall back to oppti.dev pages, checkout still succeeds', async () => {
    process.env.BILLING_REDIRECT_ALLOWLIST_ENFORCE = 'true';
    const { res, payload } = await checkout({ successUrl: HOSTILE_SUCCESS, cancelUrl: 'javascript:alert(1)' });
    expect(res.status).toBe(200);
    expect(res.body.url).toBe('https://checkout.stripe.test/c/1');
    expect(payload.success_url).toBe('https://oppti.dev/billing/success?session_id={CHECKOUT_SESSION_ID}');
    expect(payload.cancel_url).toBe('https://oppti.dev/billing/cancel');
    expect(redirectWarnings().every(([, f]) => f.enforced === true && f.action === 'fallback')).toBe(true);
  });

  test('account with no registered site: own-looking URL is unlisted, oppti.dev still allowed', async () => {
    process.env.BILLING_REDIRECT_ALLOWLIST_ENFORCE = 'true';
    const { res, payload } = await checkout({
      account: LONELY_ACCOUNT,
      siteKey: 'unknown-site-hash',
      successUrl: 'https://shop-one.example/thanks',
      cancelUrl: 'https://oppti.dev/pricing'
    });
    expect(res.status).toBe(200);
    expect(payload.success_url).toBe('https://oppti.dev/billing/success?session_id={CHECKOUT_SESSION_ID}');
    expect(payload.cancel_url).toBe('https://oppti.dev/pricing');
    const [[, fields]] = redirectWarnings();
    expect(fields).toMatchObject({ field: 'successUrl', reason: 'no_registered_site', registered_host_count: 0 });
  });

  test('no caller URLs: existing defaults, no lookups logged', async () => {
    const { res, payload } = await checkout({});
    expect(res.status).toBe(200);
    expect(payload.success_url).toMatch(/\/billing\/success\?session_id=\{CHECKOUT_SESSION_ID\}$/);
    expect(payload.cancel_url).toMatch(/\/billing\/cancel$/);
    expect(redirectWarnings()).toHaveLength(0);
  });
});

describe('POST /billing/checkout with an active subscription (portal redirect)', () => {
  async function upgradeCheckout(cancelUrl) {
    const supabase = createTableMock({
      licenses: [ACCOUNT],
      sites: [{ id: 'site-1', site_hash: 'site-hash-1', wp_install_uuid: 'site-hash-1', license_key: 'lic-1', owner_user_id: 'acct-1', status: 'active', site_url: 'https://shop-one.example' }],
      site_memberships: [],
      site_subscriptions: [{ id: 'sub-row-1', site_id: 'site-1', status: 'active', plan_id: 'starter', stripe_customer_id: 'cus_test_9', stripe_subscription_id: 'sub_test_9' }]
    });
    const stripe = buildStripe();
    const account = { ...ACCOUNT, stripe_customer_id: 'cus_test_9', stripe_subscription_id: 'sub_test_9' };
    const res = await request(buildApp({ supabase, stripe, account }))
      .post('/billing/checkout')
      .set('X-Site-Key', 'site-hash-1')
      .send({ priceId: 'price_pro', cancelUrl });
    return { res, args: stripe.billingPortal.sessions.create.mock.calls[0]?.[0] };
  }

  test('flag on: hostile cancelUrl becomes https://oppti.dev/account; listed one passes', async () => {
    process.env.BILLING_REDIRECT_ALLOWLIST_ENFORCE = 'true';
    let result = await upgradeCheckout('https://attacker.test/x');
    expect(result.res.status).toBe(200);
    expect(result.res.body.portal).toBe(true);
    expect(result.args.return_url).toBe('https://oppti.dev/account');
    expect(redirectWarnings()[0][1]).toMatchObject({ route: 'checkout_portal', field: 'cancelUrl', host: 'attacker.test', enforced: true });

    result = await upgradeCheckout('https://www.shop-one.example/wp-admin/');
    expect(result.args.return_url).toBe('https://www.shop-one.example/wp-admin/');
  });
});

describe('POST /billing/portal returnUrl allowlist', () => {
  async function portal(returnUrl, account = { ...ACCOUNT, stripe_customer_id: 'cus_test_1' }) {
    const stripe = buildStripe();
    const res = await request(buildApp({ supabase: buildSupabase(), stripe, account }))
      .post('/billing/portal')
      .set('X-Site-Key', 'site-hash-1')
      .send({ returnUrl });
    return { res, args: stripe.billingPortal.sessions.create.mock.calls[0]?.[0] };
  }

  test('listed site passes, flag on', async () => {
    process.env.BILLING_REDIRECT_ALLOWLIST_ENFORCE = '1';
    const { res, args } = await portal('https://shop-one.example/wp-admin/admin.php?page=bbai-billing');
    expect(res.status).toBe(200);
    expect(args.return_url).toBe('https://shop-one.example/wp-admin/admin.php?page=bbai-billing');
    expect(redirectWarnings()).toHaveLength(0);
  });

  test('hostile host: used as sent with the flag off, /account with the flag on', async () => {
    let result = await portal('https://attacker.test/after-portal');
    expect(result.res.status).toBe(200);
    expect(result.args.return_url).toBe('https://attacker.test/after-portal');
    expect(redirectWarnings()[0][1]).toMatchObject({ field: 'returnUrl', route: 'portal', host: 'attacker.test', enforced: false });

    process.env.BILLING_REDIRECT_ALLOWLIST_ENFORCE = 'true';
    result = await portal('https://attacker.test/after-portal');
    expect(result.res.status).toBe(200);
    expect(result.args.return_url).toBe('https://oppti.dev/account');
  });
});
