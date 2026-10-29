/**
 * Billing account routes behind the real auth middleware. Site headers
 * (site key, site hash, site URL, fingerprint) identify a site, not who may
 * manage its billing: portal, /me/invoices, /me/subscriptions, /dashboard and
 * /billing/subscription and /billing/info need a signed-in account (JWT) or a
 * licence key that matches a licence exactly. A site-header-only checkout on a
 * site that already has a subscription gets the same fixed 401 body as every
 * other refused billing call. Addresses are @qa.oppti.dev only.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'qa-test-jwt-secret';

const crypto = require('crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const request = require('supertest');

const { authMiddleware } = require('../../middleware/auth');
const { createBillingRouter } = require('../../routes/billing');
const { createAccountDashboardRouter } = require('../../routes/accountDashboard');
const logger = require('../../lib/logger');
const emailService = require('../../lib/email');

const B_DOMAIN = 'bravo-shop.example';
const B_HASH_FROM_DOMAIN = crypto.createHash('md5').update(B_DOMAIN).digest('hex');

const A = { id: 'acct-a', license_key: 'lic-aaaaaaaaaaaa', email: 'a@qa.oppti.dev', plan: 'pro', status: 'active', stripe_customer_id: 'cus_AAAAAAAAAAAA1111', stripe_subscription_id: 'sub_AAAAAAAAAAAA1111' };
const B = { id: 'acct-b', license_key: 'lic-bbbbbbbbbbbb', email: 'b@qa.oppti.dev', plan: 'pro', status: 'active', stripe_customer_id: 'cus_BBBBBBBBBBBB2222', stripe_subscription_id: 'sub_BBBBBBBBBBBB2222' };
const N = { id: 'acct-n', license_key: 'lic-nnnnnnnnnnnn', email: 'n@qa.oppti.dev', plan: 'free', status: 'active' };
const FULL_STRIPE_ID = /\b(cus|sub)_[A-Za-z0-9]{5,}/;

let tables;
function seed() {
  tables = {
    licenses: [A, B, N].map((row) => ({ ...row })),
    sites: [
      { id: 'site-a', site_hash: 'hash-aaaaaaaaaaaaaaaa', license_key: A.license_key, owner_user_id: 'acct-a', status: 'active', site_url: 'https://alpha.example', last_seen_at: '2026-10-01' },
      { id: 'site-b', site_hash: 'hash-bbbbbbbbbbbbbbbb', license_key: B.license_key, owner_user_id: 'acct-b', status: 'active', site_url: `https://${B_DOMAIN}`, last_seen_at: '2026-10-21' },
      { id: 'site-b2', site_hash: B_HASH_FROM_DOMAIN, license_key: B.license_key, owner_user_id: 'acct-b', status: 'active', site_url: `https://www.${B_DOMAIN}`, last_seen_at: '2026-10-20' },
      { id: 'site-n', site_hash: 'hash-nnnnnnnnnnnnnnnn', license_key: N.license_key, owner_user_id: 'acct-n', status: 'active', site_url: 'https://november.example', last_seen_at: '2026-10-19' }
    ],
    site_memberships: [],
    site_subscriptions: [
      { id: 'ss-a', site_id: 'site-a', status: 'active', plan_id: 'pro', stripe_customer_id: A.stripe_customer_id, stripe_subscription_id: A.stripe_subscription_id, current_period_end: '2026-11-30' },
      { id: 'ss-b', site_id: 'site-b', status: 'active', plan_id: 'agency', stripe_customer_id: B.stripe_customer_id, stripe_subscription_id: B.stripe_subscription_id, current_period_end: '2026-11-30' }
    ]
  };
}

// In-memory Supabase stand-in with enough of the query surface for the auth
// middleware and site resolution; inserts are kept so memberships are visible.
function supabaseMock() {
  return {
    from(table) {
      const filters = [];
      let limitTo = null;
      let orderBy = null;
      let pendingInsert = null;
      const rows = () => {
        let out = (tables[table] || []).filter((row) => filters.every((f) => f(row)));
        if (orderBy) out = [...out].sort((x, y) => String(y[orderBy] || '').localeCompare(String(x[orderBy] || '')));
        return limitTo ? out.slice(0, limitTo) : out;
      };
      const commit = () => {
        if (!pendingInsert) return null;
        const added = pendingInsert.map((row, i) => ({ id: `${table}-new-${(tables[table] || []).length + i}`, ...row }));
        tables[table] = [...(tables[table] || []), ...added];
        pendingInsert = null;
        return added;
      };
      const chain = {
        select() { return chain; },
        update() { return chain; },
        delete() { return chain; },
        insert(payload) { pendingInsert = Array.isArray(payload) ? payload : [payload]; return chain; },
        upsert(payload) { pendingInsert = Array.isArray(payload) ? payload : [payload]; return chain; },
        order(column) { orderBy = column; return chain; },
        limit(n) { limitTo = n; return chain; },
        neq() { return chain; },
        gte() { return chain; },
        lte() { return chain; },
        is() { return chain; },
        not() { return chain; },
        or() { return chain; },
        eq(column, value) { filters.push((row) => row?.[column] === value); return chain; },
        in(column, values) { filters.push((row) => values.includes(row?.[column])); return chain; },
        ilike(column, pattern) {
          const re = new RegExp(`^${pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.')}$`, 'i');
          filters.push((row) => re.test(String(row?.[column] || '')));
          return chain;
        },
        maybeSingle() { const added = commit(); return Promise.resolve({ data: added ? added[0] : rows()[0] || null, error: null }); },
        single() {
          const added = commit();
          if (added) return Promise.resolve({ data: added[0], error: null });
          const row = rows()[0] || null;
          // PostgREST's real no-row shape for .single(), which validateLicense reads as "not found".
          return Promise.resolve({ data: row, error: row ? null : { code: 'PGRST116', details: 'The result contains 0 rows', message: 'JSON object requested, multiple (or no) rows returned' } });
        },
        then(resolve, reject) { const added = commit(); return Promise.resolve({ data: added || rows(), error: null }).then(resolve, reject); }
      };
      return chain;
    }
  };
}

function stripeStub() {
  return {
    billingPortal: { sessions: { create: jest.fn(async () => ({ url: 'https://billing.stripe.test/p/session' })) } },
    checkout: { sessions: { create: jest.fn(async () => ({ id: 'cs_test_SessionAbcdef9876', url: 'https://checkout.stripe.test/c/1' })), retrieve: jest.fn(), list: jest.fn(async () => ({ data: [] })) } },
    invoices: { list: jest.fn(async () => ({ data: [{ id: 'in_1', amount_paid: 1200, currency: 'gbp', created: 1760000000, status: 'paid' }], has_more: false })) },
    subscriptions: { retrieve: jest.fn(async () => ({})), list: jest.fn(async () => ({ data: [] })) },
    customers: { retrieve: jest.fn(async () => ({})) }
  };
}

function buildApp() {
  const supabase = supabaseMock();
  const stripe = stripeStub();
  const app = express();
  app.use(express.json());
  app.use(authMiddleware({ supabase }));
  app.use('/', createAccountDashboardRouter({ supabase, getStripe: () => stripe }));
  app.use('/billing', createBillingRouter({
    supabase,
    getStripe: () => stripe,
    priceIds: { starter: 'price_starter', pro: 'price_pro', agency: 'price_agency', credits: 'price_credits' }
  }));
  return { app, stripe };
}

// The one body every refused site-header-only billing call gets: code and a
// fixed message, nothing else.
const SIGN_IN_REQUIRED_TEXT = JSON.stringify({
  code: 'SIGN_IN_REQUIRED',
  message: 'Sign in to manage billing.'
});

// [name, call, status for a request the middleware signed in by site headers]
const ROUTES = [
  ['POST /billing/portal', (app, headers) => send(request(app).post('/billing/portal'), headers).send({ returnUrl: 'https://alpha.example/wp-admin/' }), 401],
  ['POST /billing/checkout (active subscription)', (app, headers) => send(request(app).post('/billing/checkout'), headers).send({ priceId: 'price_pro' }), 401],
  ['POST /billing/checkout credits (active subscription)', (app, headers) => send(request(app).post('/billing/checkout'), headers).send({ priceId: 'price_credits' }), 401],
  ['GET /me/invoices', (app, headers) => send(request(app).get('/me/invoices'), headers), 401],
  ['GET /me/subscriptions', (app, headers) => send(request(app).get('/me/subscriptions'), headers), 401],
  ['GET /dashboard', (app, headers) => send(request(app).get('/dashboard'), headers), 401],
  ['GET /billing/subscription', (app, headers) => send(request(app).get('/billing/subscription'), headers), 401],
  ['GET /billing/info', (app, headers) => send(request(app).get('/billing/info'), headers), 401]
];
function send(req, headers) {
  return Object.entries(headers).reduce((r, [k, v]) => r.set(k, v), req);
}
const portalCustomers = (stripe) => stripe.billingPortal.sessions.create.mock.calls.map((c) => c[0].customer);
const invoiceCustomers = (stripe) => stripe.invoices.list.mock.calls.map((c) => c[0].customer);
const touchedB = (stripe) => portalCustomers(stripe).includes(B.stripe_customer_id)
  || invoiceCustomers(stripe).includes(B.stripe_customer_id);

let spies;
beforeAll(() => {
  process.env.CHECKOUT_CREDITS_RATE_LIMIT_PER_15_MIN = '1000';
  process.env.CHECKOUT_RATE_LIMIT_PER_15_MIN = '1000';
  process.env.SIGN_IN_REFUSAL_RATE_LIMIT_PER_15_MIN = '100000';
});
beforeEach(() => {
  seed();
  spies = ['info', 'warn', 'error', 'debug'].map((level) => jest.spyOn(logger, level).mockImplementation(() => {}));
});
afterEach(() => jest.restoreAllMocks());

// [label, headers, signed in by site headers (true) or refused by the licence check (false)]
const SITE_ONLY_CASES = [
  ['X-Site-Key = B\'s site hash', { 'X-Site-Key': 'hash-bbbbbbbbbbbbbbbb', 'X-Site-Hash': 'hash-bbbbbbbbbbbbbbbb' }, true],
  ['X-Site-Key = hash of B\'s domain', { 'X-Site-Key': B_HASH_FROM_DOMAIN }, true],
  ['made-up site key + X-Site-URL = B\'s domain', { 'X-Site-Key': 'made-up-key', 'X-Site-URL': B_DOMAIN }, true],
  ['made-up site key + one-letter X-Site-URL', { 'X-Site-Key': 'x', 'X-Site-URL': 'o' }, true],
  ['invalid Bearer token + B\'s site hash', { 'X-Site-Key': 'hash-bbbbbbbbbbbbbbbb', Authorization: 'Bearer not-a-real-token' }, true],
  ['X-License-Key carrying B\'s site hash', { 'X-Site-Key': 'hash-bbbbbbbbbbbbbbbb', 'X-License-Key': 'hash-bbbbbbbbbbbbbbbb' }, false],
  ['X-License-Key carrying the hash of B\'s domain', { 'X-Site-Key': B_HASH_FROM_DOMAIN, 'X-License-Key': B_HASH_FROM_DOMAIN }, false]
];

describe.each(ROUTES)('%s', (_name, call, siteAuthStatus) => {
  test.each(SITE_ONLY_CASES)('%s is refused and touches nothing of B', async (_label, headers, signedInBySite) => {
    const { app, stripe } = buildApp();
    const res = await call(app, headers);
    expect(res.status).toBe(signedInBySite ? siteAuthStatus : 401);
    if (signedInBySite) {
      expect(res.text).toBe(SIGN_IN_REQUIRED_TEXT);
      expect(res.headers['content-type']).toMatch(/^application\/json/);
    }
    expect(touchedB(stripe)).toBe(false);
    expect(stripe.billingPortal.sessions.create).not.toHaveBeenCalled();
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
    expect(JSON.stringify(res.body)).not.toContain('BBBBBBBB');
    expect(JSON.stringify(res.body)).not.toContain('agency');
  });

  test('A\'s own licence key works and never reaches B', async () => {
    const { app, stripe } = buildApp();
    const res = await call(app, { 'X-Site-Key': 'hash-aaaaaaaaaaaaaaaa', 'X-License-Key': A.license_key });
    expect(res.status).toBe(200);
    expect(touchedB(stripe)).toBe(false);
    expect(JSON.stringify(res.body)).not.toMatch(FULL_STRIPE_ID);
  });

  test('A\'s own licence key with B\'s site header still never reaches B', async () => {
    const { app, stripe } = buildApp();
    const res = await call(app, { 'X-Site-Key': 'hash-bbbbbbbbbbbbbbbb', 'X-Site-URL': B_DOMAIN, 'X-License-Key': A.license_key });
    expect(res.status).toBe(200);
    expect(touchedB(stripe)).toBe(false);
    expect(JSON.stringify(res.body)).not.toContain('BBBBBBBB');
    expect(JSON.stringify(res.body)).not.toContain('agency');
  });

  test('A signed in with a JWT works', async () => {
    const { app, stripe } = buildApp();
    const token = jwt.sign({ user_id: A.id, email: A.email }, process.env.JWT_SECRET);
    const res = await call(app, { 'X-Site-Key': 'hash-aaaaaaaaaaaaaaaa', Authorization: `Bearer ${token}` });
    expect(res.status).toBe(200);
    expect(touchedB(stripe)).toBe(false);
  });
});

describe('site membership never proves billing ownership', () => {
  test('signed-in N using B\'s site key on checkout gets no membership, no B site in metadata, and no B portal after', async () => {
    const { app, stripe } = buildApp();
    const headersB = { 'X-Site-Key': 'hash-bbbbbbbbbbbbbbbb', 'X-Site-URL': `https://${B_DOMAIN}`, 'X-License-Key': N.license_key };
    const checkout = await send(request(app).post('/billing/checkout'), headersB).send({ priceId: 'price_credits' });
    expect(checkout.status).toBe(200);
    expect(tables.site_memberships.some((m) => m.user_id === N.id && ['site-b', 'site-b2'].includes(m.site_id))).toBe(false);
    const { metadata } = stripe.checkout.sessions.create.mock.calls[0][0];
    expect(metadata.account_id).toBe(N.id);
    expect(JSON.stringify(metadata)).not.toMatch(/site-b|hash-bbbb|lic-bbbb|acct-b/);

    const sub = await send(request(app).get('/billing/subscription'), headersB);
    expect(sub.status).toBe(200);
    expect(sub.body.data.plan).toBe('free');
    expect(tables.site_memberships.some((m) => m.user_id === N.id && m.site_id === 'site-b')).toBe(false);

    const portal = await send(request(app).post('/billing/portal'), { 'X-Site-Key': 'hash-nnnn', 'X-License-Key': N.license_key })
      .send({ customerId: B.stripe_customer_id });
    expect(portal.status).toBe(403);
    expect(touchedB(stripe)).toBe(false);
  });

  test('an existing membership row for N on B\'s site does not open B\'s portal or plan', async () => {
    const { app, stripe } = buildApp();
    tables.site_memberships.push({ site_id: 'site-b', user_id: N.id, role: 'member' });
    const portal = await send(request(app).post('/billing/portal'), { 'X-Site-Key': 'hash-bbbbbbbbbbbbbbbb', 'X-License-Key': N.license_key })
      .send({ customerId: B.stripe_customer_id });
    expect(portal.status).toBe(403);
    const sub = await send(request(app).get('/billing/subscription'), { 'X-Site-Key': 'hash-bbbbbbbbbbbbbbbb', 'X-License-Key': N.license_key });
    expect(sub.body.data.plan).toBe('free');
    expect(touchedB(stripe)).toBe(false);
  });
});

describe('site-header-only checkout', () => {
  // Exactly the headers Alt Text 4.6.143 sends when it has no licence key or
  // token stored (class-api-client-v2.php get_auth_headers), and its body.
  const loggedOutAltText = (hash, url) => ({
    'Content-Type': 'application/json',
    'X-Site-Hash': hash,
    'X-Site-Key': hash,
    'X-Site-URL': url,
    'X-Site-Fingerprint': 'fp-qa-logged-out'
  });
  const altTextBody = (priceId) => ({
    priceId,
    successUrl: 'https://november.example/wp-admin/admin.php?page=bbai&checkout=success',
    cancelUrl: 'https://november.example/wp-admin/admin.php?page=bbai&checkout=cancel',
    plugin_version: '4.6.143',
    site_install_id: 'hash-nnnnnnnnnnnnnnnn'
  });

  test('logged-out Alt Text request still creates a new checkout session for a site with no subscription', async () => {
    const { app, stripe } = buildApp();
    const res = await send(request(app).post('/billing/checkout'), loggedOutAltText('hash-nnnnnnnnnnnnnnnn', 'https://november.example'))
      .send(altTextBody('price_pro'));
    expect(res.status).toBe(200);
    expect(res.body.url).toBe('https://checkout.stripe.test/c/1');
    expect(res.body.sessionId).toBe('cs_test_SessionAbcdef9876');
    expect(stripe.checkout.sessions.create).toHaveBeenCalledTimes(1);
    const { metadata } = stripe.checkout.sessions.create.mock.calls[0][0];
    expect(metadata).toMatchObject({ license_key: N.license_key, site_id: 'site-n', site_hash: 'hash-nnnnnnnnnnnnnnnn' });
  });

  test('logged-out Alt Text one-off credits checkout still works on a site with no subscription', async () => {
    const { app, stripe } = buildApp();
    const res = await send(request(app).post('/billing/checkout'), loggedOutAltText('hash-nnnnnnnnnnnnnnnn', 'https://november.example'))
      .send(altTextBody('price_credits'));
    expect(res.status).toBe(200);
    expect(res.body.sessionId).toBe('cs_test_SessionAbcdef9876');
    expect(stripe.checkout.sessions.create).toHaveBeenCalledTimes(1);
  });

  test('on a site with a subscription every plan gets the same 401 bytes and makes no Stripe call', async () => {
    tables.site_subscriptions.push({ id: 'ss-b2', site_id: 'site-b2', status: 'trialing', plan_id: 'pro', stripe_customer_id: null, stripe_subscription_id: 'sub_NoCustomer000000002', current_period_end: '2027-01-15' });
    const { app, stripe } = buildApp();
    const bodies = [];
    for (const [hash, url, priceId] of [
      ['hash-bbbbbbbbbbbbbbbb', `https://${B_DOMAIN}`, 'price_pro'],
      ['hash-bbbbbbbbbbbbbbbb', `https://${B_DOMAIN}`, 'price_agency'],
      ['hash-bbbbbbbbbbbbbbbb', `https://${B_DOMAIN}`, 'price_credits'],
      [B_HASH_FROM_DOMAIN, `https://www.${B_DOMAIN}`, 'price_starter'],
      ['hash-aaaaaaaaaaaaaaaa', 'https://alpha.example', 'price_pro'],
      ['hash-aaaaaaaaaaaaaaaa', 'https://alpha.example', 'price_credits']
    ]) {
      const res = await send(request(app).post('/billing/checkout'), loggedOutAltText(hash, url)).send(altTextBody(priceId));
      expect(res.status).toBe(401);
      expect(res.headers['content-type']).toMatch(/^application\/json/);
      bodies.push(res.text);
    }
    expect(new Set(bodies)).toEqual(new Set([SIGN_IN_REQUIRED_TEXT]));
    expect(JSON.parse(bodies[0])).toEqual({ code: 'SIGN_IN_REQUIRED', message: 'Sign in to manage billing.' });
    expect(stripe.billingPortal.sessions.create).not.toHaveBeenCalled();
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
    expect(stripe.checkout.sessions.list).not.toHaveBeenCalled();
    expect(stripe.checkout.sessions.retrieve).not.toHaveBeenCalled();
  });
});

describe('one sign-in reply for every refused site-header-only billing call', () => {
  test('reads, portal, and paying-site checkout all return byte-identical 401 bodies with no Stripe call', async () => {
    const { app, stripe } = buildApp();
    const bodies = new Set();
    const headerSets = [
      { 'X-Site-Key': 'hash-bbbbbbbbbbbbbbbb', 'X-Site-Hash': 'hash-bbbbbbbbbbbbbbbb', 'X-Site-URL': `https://${B_DOMAIN}`, 'X-Site-Fingerprint': 'fp-qa' },
      { 'X-Site-Key': 'hash-aaaaaaaaaaaaaaaa', 'X-Site-URL': 'https://alpha.example' },
      { 'X-Site-Key': 'hash-nnnnnnnnnnnnnnnn', 'X-Site-URL': 'https://november.example' }
    ];
    for (const headers of headerSets) {
      for (const [name, call] of ROUTES) {
        const res = await call(app, headers);
        // N's site has no subscription, so its checkout is a guest checkout.
        if (headers['X-Site-Key'] === 'hash-nnnnnnnnnnnnnnnn' && name.startsWith('POST /billing/checkout')) {
          expect(res.status).toBe(200);
          continue;
        }
        expect(res.status).toBe(401);
        bodies.add(res.text);
      }
    }
    expect([...bodies]).toEqual([SIGN_IN_REQUIRED_TEXT]);
    expect(stripe.billingPortal.sessions.create).not.toHaveBeenCalled();
    expect(stripe.invoices.list).not.toHaveBeenCalled();
    expect(stripe.subscriptions.list).not.toHaveBeenCalled();
    expect(stripe.subscriptions.retrieve).not.toHaveBeenCalled();
    expect(stripe.customers.retrieve).not.toHaveBeenCalled();
    expect(stripe.checkout.sessions.create).toHaveBeenCalledTimes(2);
  });

  test('a refused checkout writes no site membership', async () => {
    const { app } = buildApp();
    const before = tables.site_memberships.length;
    const res = await send(request(app).post('/billing/checkout'), { 'X-Site-Key': 'hash-bbbbbbbbbbbbbbbb', 'X-Site-URL': `https://${B_DOMAIN}` })
      .send({ priceId: 'price_pro' });
    expect(res.status).toBe(401);
    expect(tables.site_memberships.length).toBe(before);
  });
});

describe('checkout email-link with a session id', () => {
  const OPEN = { id: 'cs_test_OpenSessionB1234', status: 'open', url: 'https://checkout.stripe.test/c/b', client_reference_id: 'acct-b', metadata: { account_id: 'acct-b', plan: 'pro' } };
  beforeEach(() => {
    jest.spyOn(emailService, 'isAvailable').mockReturnValue(true);
    jest.spyOn(emailService, 'sendCheckoutLinkEmail').mockResolvedValue({ success: true });
  });

  test('site headers only: the reply carries no email, customer or subscription detail', async () => {
    const { app, stripe } = buildApp();
    stripe.checkout.sessions.retrieve.mockResolvedValue(OPEN);
    const res = await send(request(app).post('/billing/checkout/email-link'), { 'X-Site-Key': 'hash-bbbbbbbbbbbbbbbb' })
      .send({ session_id: OPEN.id });
    expect(res.status).toBe(200);
    expect(res.text).toBe(JSON.stringify({ success: true }));
  });

  test('no credentials at all: 401', async () => {
    const { app, stripe } = buildApp();
    stripe.checkout.sessions.retrieve.mockResolvedValue(OPEN);
    const res = await request(app).post('/billing/checkout/email-link').send({ session_id: OPEN.id });
    expect(res.status).toBe(401);
    expect(stripe.checkout.sessions.retrieve).not.toHaveBeenCalled();
  });

  test('another account\'s session id with A\'s licence: 403, nothing about B', async () => {
    const { app, stripe } = buildApp();
    stripe.checkout.sessions.retrieve.mockResolvedValue(OPEN);
    const res = await send(request(app).post('/billing/checkout/email-link'), { 'X-Site-Key': 'hash-aaaaaaaaaaaaaaaa', 'X-License-Key': A.license_key })
      .send({ session_id: OPEN.id });
    expect(res.status).toBe(403);
    expect(res.text).not.toMatch(/b@qa|acct-b|cus_|sub_/);
  });

  test('own licence: the masked address is shown', async () => {
    const { app, stripe } = buildApp();
    stripe.checkout.sessions.retrieve.mockResolvedValue({ ...OPEN, client_reference_id: 'acct-a', metadata: { account_id: 'acct-a' } });
    const res = await send(request(app).post('/billing/checkout/email-link'), { 'X-Site-Key': 'hash-aaaaaaaaaaaaaaaa', 'X-License-Key': A.license_key })
      .send({ session_id: OPEN.id });
    expect(res.status).toBe(200);
    expect(res.body.sent_to).toMatch(/@qa\.oppti\.dev$/);
  });
});

describe('dashboard and subscriptions list only the account\'s own billing', () => {
  test('N with a membership on B\'s site sees none of B\'s subscription', async () => {
    const { app } = buildApp();
    tables.site_memberships.push({ site_id: 'site-b', user_id: N.id, role: 'member' });
    for (const path of ['/me/subscriptions', '/dashboard']) {
      const res = await send(request(app).get(path), { 'X-Site-Key': 'hash-nnnnnnnnnnnnnnnn', 'X-License-Key': N.license_key });
      expect(res.status).toBe(200);
      expect(res.text).not.toMatch(/BBBBBBBB|agency|ss-b/);
    }
  });

  test('A sees its own subscription with the Stripe id masked', async () => {
    const { app } = buildApp();
    const res = await send(request(app).get('/me/subscriptions'), { 'X-Site-Key': 'hash-aaaaaaaaaaaaaaaa', 'X-License-Key': A.license_key });
    expect(res.status).toBe(200);
    expect(res.body.subscriptions[0]).toMatchObject({ plan_name: 'Pro', stripe_subscription_id: 'sub_***1111' });
    expect(res.text).not.toMatch(FULL_STRIPE_ID);
  });
});

describe('responses and logs', () => {
  test('checkout portal redirect for A masks the Stripe ids in the response', async () => {
    const { app } = buildApp();
    const res = await send(request(app).post('/billing/checkout'), { 'X-Site-Key': 'hash-aaaaaaaaaaaaaaaa', 'X-License-Key': A.license_key }).send({ priceId: 'price_pro' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ portal: true, customerId: 'cus_***1111', subscriptionId: 'sub_***1111' });
  });

  test('a new checkout session keeps its session id (needed for the email-link fallback)', async () => {
    const { app } = buildApp();
    const res = await send(request(app).post('/billing/checkout'), { 'X-Site-Key': 'hash-nnnnnnnnnnnnnnnn', 'X-License-Key': N.license_key }).send({ priceId: 'price_credits' });
    expect(res.status).toBe(200);
    expect(res.body.sessionId).toBe('cs_test_SessionAbcdef9876');
  });

  test('billing logs carry no full customer or subscription id across the refused and allowed calls', async () => {
    const { app } = buildApp();
    for (const [, call] of ROUTES) {
      await call(app, { 'X-Site-Key': 'hash-bbbbbbbbbbbbbbbb' });
      await call(app, { 'X-Site-Key': 'hash-aaaaaaaaaaaaaaaa', 'X-License-Key': A.license_key });
    }
    const text = JSON.stringify(spies.map((spy) => spy.mock.calls));
    expect(text).not.toMatch(FULL_STRIPE_ID);
  });
});

describe('checkout prefill', () => {
  const createParams = (stripe) => stripe.checkout.sessions.create.mock.calls.map((c) => c[0]);
  const siteOnly = { 'X-Site-Hash': 'hash-nnnnnnnnnnnnnnnn', 'X-Site-Key': 'hash-nnnnnnnnnnnnnnnn', 'X-Site-URL': 'https://november.example', 'X-Site-Fingerprint': 'fp-qa' };

  test.each([
    ['subscription', 'price_pro'],
    ['one-off credits', 'price_credits']
  ])('site headers only (%s): no customer or customer_email, metadata still names the licence and site', async (_label, priceId) => {
    tables.licenses.find((row) => row.id === N.id).stripe_customer_id = 'cus_NNNNNNNNNNNN3333';
    const { app, stripe } = buildApp();
    const res = await send(request(app).post('/billing/checkout'), siteOnly).send({ priceId });
    expect(res.status).toBe(200);
    const [params] = createParams(stripe);
    expect(params).not.toHaveProperty('customer');
    expect(params).not.toHaveProperty('customer_email');
    expect(params.metadata).toMatchObject({ account_id: N.id, license_key: N.license_key, site_id: 'site-n', site_hash: 'hash-nnnnnnnnnnnnnnnn' });
    expect(params.client_reference_id).toBe(N.id);
  });

  test('site headers only, licence without a Stripe customer: no customer_email', async () => {
    const { app, stripe } = buildApp();
    const res = await send(request(app).post('/billing/checkout'), siteOnly).send({ priceId: 'price_pro' });
    expect(res.status).toBe(200);
    const [params] = createParams(stripe);
    expect(params).not.toHaveProperty('customer');
    expect(params).not.toHaveProperty('customer_email');
    expect(JSON.stringify(res.body)).not.toContain('@');
  });

  test('licence key: customer_email still prefilled for an account without a Stripe customer', async () => {
    const { app, stripe } = buildApp();
    const res = await send(request(app).post('/billing/checkout'), { ...siteOnly, 'X-License-Key': N.license_key }).send({ priceId: 'price_pro' });
    expect(res.status).toBe(200);
    expect(createParams(stripe)[0].customer_email).toBe(N.email);
  });

  test('licence key: existing Stripe customer still attached', async () => {
    tables.licenses.find((row) => row.id === N.id).stripe_customer_id = 'cus_NNNNNNNNNNNN3333';
    const { app, stripe } = buildApp();
    const res = await send(request(app).post('/billing/checkout'), { ...siteOnly, 'X-License-Key': N.license_key }).send({ priceId: 'price_credits' });
    expect(res.status).toBe(200);
    expect(createParams(stripe)[0].customer).toBe('cus_NNNNNNNNNNNN3333');
  });

  test('JWT: customer_email still prefilled', async () => {
    const { app, stripe } = buildApp();
    const token = jwt.sign({ user_id: N.id, email: N.email }, process.env.JWT_SECRET);
    const res = await send(request(app).post('/billing/checkout'), { ...siteOnly, Authorization: `Bearer ${token}` }).send({ priceId: 'price_pro' });
    expect(res.status).toBe(200);
    const [params] = createParams(stripe);
    expect(params.customer_email || params.customer).toBeTruthy();
  });

  test('email-link for a site-only session still works and still replies with no address', async () => {
    jest.spyOn(emailService, 'isAvailable').mockReturnValue(true);
    const sendSpy = jest.spyOn(emailService, 'sendCheckoutLinkEmail').mockResolvedValue({ success: true });
    const { app, stripe } = buildApp();
    const created = await send(request(app).post('/billing/checkout'), siteOnly).send({ priceId: 'price_pro' });
    const params = createParams(stripe)[0];
    stripe.checkout.sessions.retrieve.mockResolvedValue({ id: created.body.sessionId, status: 'open', url: created.body.url, client_reference_id: params.client_reference_id, metadata: params.metadata });
    const res = await send(request(app).post('/billing/checkout/email-link'), siteOnly).send({ session_id: created.body.sessionId });
    expect(res.status).toBe(200);
    expect(res.text).toBe(JSON.stringify({ success: true }));
    expect(sendSpy).toHaveBeenCalledTimes(1);
  });
});

// The shared request counters; a fresh Map stands in where the module is absent.
function rateBuckets() {
  try {
    return require('../../lib/checkoutRateLimit').checkoutRateBuckets;
  } catch (_error) {
    return new Map();
  }
}

describe('refused calls count in the rate limiter', () => {
  const checkoutRateBuckets = { clear: () => rateBuckets().clear() };
  const payingSite = { 'X-Site-Hash': 'hash-bbbbbbbbbbbbbbbb', 'X-Site-Key': 'hash-bbbbbbbbbbbbbbbb', 'X-Site-URL': `https://${B_DOMAIN}` };
  const freeSite = { 'X-Site-Hash': 'hash-nnnnnnnnnnnnnnnn', 'X-Site-Key': 'hash-nnnnnnnnnnnnnnnn', 'X-Site-URL': 'https://november.example' };
  beforeEach(() => checkoutRateBuckets.clear());
  afterEach(() => {
    process.env.CHECKOUT_RATE_LIMIT_PER_15_MIN = '1000';
    process.env.SIGN_IN_REFUSAL_RATE_LIMIT_PER_15_MIN = '100000';
    checkoutRateBuckets.clear();
  });

  test('a refused paying-site checkout hits the checkout limit after the same number of tries as a guest checkout', async () => {
    process.env.CHECKOUT_RATE_LIMIT_PER_15_MIN = '3';
    const { app, stripe } = buildApp();
    const statuses = { paying: [], free: [] };
    const limited = [];
    for (let i = 0; i < 4; i += 1) {
      const paying = await send(request(app).post('/billing/checkout'), payingSite).send({ priceId: 'price_pro' });
      const free = await send(request(app).post('/billing/checkout'), freeSite).send({ priceId: 'price_pro' });
      statuses.paying.push(paying.status);
      statuses.free.push(free.status);
      if (paying.status === 429) limited.push(paying.text);
      if (free.status === 429) limited.push(free.text);
    }
    expect(statuses.paying).toEqual([401, 401, 401, 429]);
    expect(statuses.free).toEqual([200, 200, 200, 429]);
    expect(new Set(limited).size).toBe(1);
    expect(JSON.parse(limited[0]).code).toBe('CHECKOUT_RATE_LIMIT_EXCEEDED');
    expect(stripe.checkout.sessions.create).toHaveBeenCalledTimes(3);
  });

  test('refused reads and portal calls count per IP and then get one fixed 429 on every route', async () => {
    process.env.SIGN_IN_REFUSAL_RATE_LIMIT_PER_15_MIN = '5';
    const { app } = buildApp();
    const routes = [
      () => send(request(app).get('/billing/info'), payingSite),
      () => send(request(app).get('/billing/subscription'), freeSite),
      () => send(request(app).post('/billing/portal'), payingSite).send({}),
      () => send(request(app).get('/me/invoices'), freeSite),
      () => send(request(app).get('/dashboard'), payingSite),
      () => send(request(app).get('/me/subscriptions'), freeSite),
      () => send(request(app).get('/billing/info'), freeSite)
    ];
    const results = [];
    for (const call of routes) results.push(await call());
    expect(results.map((r) => r.status)).toEqual([401, 401, 401, 401, 401, 429, 429]);
    expect(results[5].text).toBe(results[6].text);
    expect(JSON.parse(results[5].text)).toEqual({ code: 'RATE_LIMIT_EXCEEDED', message: 'Too many requests. Please wait a few minutes and try again.' });
    expect(results[5].headers['retry-after']).toBe('900');
  });

  test('signed-in callers are not counted and not limited by refusals', async () => {
    process.env.SIGN_IN_REFUSAL_RATE_LIMIT_PER_15_MIN = '2';
    const { app } = buildApp();
    for (let i = 0; i < 3; i += 1) await send(request(app).get('/billing/info'), payingSite);
    const own = await send(request(app).get('/billing/info'), { 'X-Site-Key': 'hash-aaaaaaaaaaaaaaaa', 'X-License-Key': A.license_key });
    expect(own.status).toBe(200);
  });
});

describe('unrecognised site credentials on billing paths', () => {
  const checkoutRateBuckets = { clear: () => rateBuckets().clear() };
  const unknownSites = [
    { 'X-Site-Hash': 'hash-zzzzzzzzzzzzzzzz', 'X-Site-Key': 'hash-zzzzzzzzzzzzzzzz', 'X-Site-URL': 'https://zulu-unregistered.example', 'X-Site-Fingerprint': 'fp-qa' },
    { 'X-Site-Key': 'made-up-key-only' },
    { 'X-Site-Key': 'hash-zzzzzzzzzzzzzzzz', Authorization: 'Bearer not-a-real-token' }
  ];
  const payingSite = { 'X-Site-Hash': 'hash-bbbbbbbbbbbbbbbb', 'X-Site-Key': 'hash-bbbbbbbbbbbbbbbb', 'X-Site-URL': `https://${B_DOMAIN}`, 'X-Site-Fingerprint': 'fp-qa' };
  const freeSite = { 'X-Site-Hash': 'hash-nnnnnnnnnnnnnnnn', 'X-Site-Key': 'hash-nnnnnnnnnnnnnnnn', 'X-Site-URL': 'https://november.example', 'X-Site-Fingerprint': 'fp-qa' };
  const READS = [
    (app, h) => send(request(app).get('/billing/info'), h),
    (app, h) => send(request(app).get('/billing/subscription'), h),
    (app, h) => send(request(app).post('/billing/portal'), h).send({}),
    (app, h) => send(request(app).get('/me/invoices'), h),
    (app, h) => send(request(app).get('/me/subscriptions'), h),
    (app, h) => send(request(app).get('/dashboard'), h),
    (app, h) => send(request(app).get('/billing/subscription/'), h)
  ];
  beforeEach(() => checkoutRateBuckets.clear());
  afterEach(() => {
    process.env.CHECKOUT_RATE_LIMIT_PER_15_MIN = '1000';
    checkoutRateBuckets.clear();
  });

  test('reads and portal: unknown, free and paying sites all get the same 401 bytes', async () => {
    const { app } = buildApp();
    const bodies = new Set();
    for (const headers of [...unknownSites, freeSite, payingSite]) {
      for (const call of READS) {
        const res = await call(app, headers);
        expect(res.status).toBe(401);
        bodies.add(res.text);
      }
    }
    expect([...bodies]).toEqual([SIGN_IN_REQUIRED_TEXT]);
  });

  test('checkout: an unknown site gets the same 401 as a paying site, and the same limit', async () => {
    process.env.CHECKOUT_RATE_LIMIT_PER_15_MIN = '2';
    const { app, stripe } = buildApp();
    const run = async (headers) => {
      const out = [];
      for (let i = 0; i < 3; i += 1) {
        const res = await send(request(app).post('/billing/checkout'), headers).send({ priceId: 'price_pro' });
        out.push([res.status, res.text]);
      }
      return out;
    };
    const unknown = await run(unknownSites[0]);
    const paying = await run(payingSite);
    expect(unknown.map(([s]) => s)).toEqual([401, 401, 429]);
    expect(paying.map(([s]) => s)).toEqual([401, 401, 429]);
    expect(unknown.map(([, t]) => t)).toEqual(paying.map(([, t]) => t));
    expect(unknown[0][1]).toBe(SIGN_IN_REQUIRED_TEXT);
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
    const free = await send(request(app).post('/billing/checkout'), freeSite).send({ priceId: 'price_pro' });
    expect(free.status).toBe(200);
  });

  test('checkout from an unknown site still validates the request first, like a known one', async () => {
    const { app } = buildApp();
    const unknown = await send(request(app).post('/billing/checkout'), unknownSites[0]).send({ priceId: 'price_nope' });
    const paying = await send(request(app).post('/billing/checkout'), payingSite).send({ priceId: 'price_nope' });
    expect(unknown.status).toBe(400);
    expect(unknown.text).toBe(paying.text);
  });

  test('an X-License-Key that is not an issued key still gets the licence error (Titles routes it to reconnect)', async () => {
    const { app } = buildApp();
    for (const path of ['/billing/info', '/billing/checkout']) {
      const res = await send(request(app)[path === '/billing/info' ? 'get' : 'post'](path), { 'X-Site-Key': 'hash-zzzzzzzzzzzzzzzz', 'X-License-Key': 'lic-not-issued-0000' }).send({ priceId: 'price_pro' });
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('INVALID_LICENSE');
    }
  });

  test('non-billing paths keep the existing licence error', async () => {
    const { authMiddleware: auth } = require('../../middleware/auth');
    const other = express();
    other.use(express.json());
    other.use(auth({ supabase: supabaseMock() }));
    other.get('/api/usage', (_req, res) => res.json({ ok: true }));
    other.get('/me/sites', (_req, res) => res.json({ ok: true }));
    for (const path of ['/api/usage', '/me/sites']) {
      const res = await send(request(other).get(path), unknownSites[0]);
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('INVALID_LICENSE');
    }
  });
});

describe('checkout metadata site_install_id is hashed by the backend from X-Site-Key', () => {
  // sha256('oppti-install-v1:hash-nnnnnnnnnnnnnnnn'), the plugin formula.
  const EXPECTED_INSTALL_ID = 'de7d38e0a860196b7772ed84e538cb4729a6be7627cbc41f78da2c14b3606373';
  const headers = {
    'Content-Type': 'application/json',
    'X-Site-Hash': 'hash-nnnnnnnnnnnnnnnn',
    'X-Site-Key': 'hash-nnnnnnnnnnnnnnnn',
    'X-Site-URL': 'https://november.example'
  };
  const body = (pluginVersion, siteInstallId) => ({
    priceId: 'price_pro',
    successUrl: 'https://november.example/wp-admin/admin.php?page=bbai&checkout=success',
    cancelUrl: 'https://november.example/wp-admin/admin.php?page=bbai&checkout=cancel',
    plugin_version: pluginVersion,
    site_install_id: siteInstallId
  });

  test.each([
    ['4.6.143 (raw body site_install_id)', '4.6.143', 'hash-nnnnnnnnnnnnnnnn'],
    ['4.6.144 (already-hashed body site_install_id)', '4.6.144', EXPECTED_INSTALL_ID],
    ['no body site_install_id', '4.6.144', undefined]
  ])('%s gives the same single-hashed value', async (_label, version, bodyId) => {
    seed();
    const { app, stripe } = buildApp();
    const res = await send(request(app).post('/billing/checkout'), headers).send(body(version, bodyId));
    expect(res.status).toBe(200);
    const { metadata } = stripe.checkout.sessions.create.mock.calls[0][0];
    expect(metadata.site_install_id).toBe(EXPECTED_INSTALL_ID);
    // The site row id travels for webhook and renewal lookups.
    expect(metadata.site_id).toBe('site-n');
  });
});
