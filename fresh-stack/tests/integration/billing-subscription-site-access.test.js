/**
 * GET /billing/subscription needs a signed-in account or licence key, and
 * reports plan status only for a site on the caller's licence or owned by the
 * caller. Site headers alone get 401; site membership does not count.
 * Header shapes follow the Alt Text v2 client. Addresses are @qa.oppti.dev only.
 */
jest.mock('../../services/siteQuota', () => {
  const actual = jest.requireActual('../../services/siteQuota');
  return {
    ...actual,
    resolveCanonicalSite: jest.fn(),
    selectActiveSiteSubscription: jest.fn()
  };
});

const express = require('express');
const request = require('supertest');

const { createBillingRouter } = require('../../routes/billing');
const { resolveCanonicalSite, selectActiveSiteSubscription } = require('../../services/siteQuota');
const logger = require('../../lib/logger');
const { createTableMock } = require('../helpers/tableMock');

const OWN = { id: 'acct-own', license_key: 'lic-own', email: 'own@qa.oppti.dev', plan: 'pro', status: 'active' };
const AGENCY = { id: 'acct-agency', license_key: 'lic-agency', email: 'agency@qa.oppti.dev', plan: 'agency', status: 'active' };
const TEAMMATE = { id: 'acct-team', license_key: 'lic-team', email: 'team@qa.oppti.dev', plan: 'free', status: 'active' };

let tables;
let created;

function seed() {
  created = 0;
  tables = {
    licenses: [
      { license_key: 'lic-own', plan: 'pro', status: 'active', billing_cycle: 'monthly', stripe_subscription_id: 'sub_OwnLicenceSub0001' },
      { license_key: 'lic-agency', plan: 'agency', status: 'active', billing_cycle: 'yearly', stripe_subscription_id: 'sub_AgencyLicence9999' },
      { license_key: 'lic-team', plan: 'free', status: 'active', billing_cycle: 'monthly', stripe_subscription_id: null }
    ],
    sites: [
      { id: 'site-own', site_hash: 'hash-own', license_key: 'lic-own', owner_user_id: 'acct-own', site_url: 'https://own.example', canonical_domain: 'own.example' },
      { id: 'site-agency', site_hash: 'hash-agency', license_key: 'lic-agency', owner_user_id: 'acct-agency', site_url: 'https://agency-client.example', canonical_domain: 'agency-client.example' }
    ],
    site_memberships: [
      { site_id: 'site-own', user_id: 'acct-own', role: 'owner' },
      { site_id: 'site-agency', user_id: 'acct-agency', role: 'owner' },
      { site_id: 'site-agency', user_id: 'acct-team', role: 'member' }
    ],
    site_subscriptions: [
      { site_id: 'site-own', plan_id: 'pro', status: 'active', billing_interval: 'month', current_period_end: '2026-11-22T00:00:00.000Z', stripe_subscription_id: 'sub_OwnSiteSubscr0001', cancel_at_period_end: false },
      { site_id: 'site-agency', plan_id: 'agency', status: 'active', billing_interval: 'year', current_period_end: '2027-03-01T00:00:00.000Z', stripe_subscription_id: 'sub_AgencySiteSub9999', cancel_at_period_end: true }
    ]
  };
}

// Mirrors resolveCanonicalSite: matches by hash or domain, attaches the
// account as a member of whatever it matched, creates when asked.
function fakeResolve(_supabase, identity, { createIfMissing = false, account = null, legacyLicenseKey = null } = {}) {
  const site = tables.sites.find((row) => row.site_hash === identity.siteHash || (identity.siteHash && row.site_hash && identity.siteHash.startsWith(`${row.site_hash}-`)))
    || tables.sites.find((row) => identity.canonicalDomain && row.canonical_domain === identity.canonicalDomain);
  const attach = (target, role) => {
    if (account?.id && !tables.site_memberships.some((m) => m.site_id === target.id && m.user_id === account.id)) {
      tables.site_memberships.push({ site_id: target.id, user_id: account.id, role });
    }
  };
  if (site) {
    attach(site, site.owner_user_id === account?.id ? 'owner' : 'member');
    return Promise.resolve({ site, matchedBy: 'site_hash', created: false, error: null });
  }
  if (!createIfMissing) return Promise.resolve({ site: null, created: false, error: 'SITE_NOT_FOUND' });
  created += 1;
  const fresh = {
    id: `site-new-${created}`,
    site_hash: identity.siteHash,
    license_key: legacyLicenseKey || account?.license_key || null,
    owner_user_id: account?.id || null,
    canonical_domain: identity.canonicalDomain || null
  };
  tables.sites.push(fresh);
  attach(fresh, 'owner');
  return Promise.resolve({ site: fresh, matchedBy: 'created', created: true, error: null });
}

function buildApp({ license = null, user = null, authMethod = null } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.license = license; req.user = user; req.authMethod = authMethod || (user ? 'jwt' : license ? 'license' : undefined); next(); });
  app.use('/billing', createBillingRouter({ supabase: createTableMock(tables), getStripe: () => null, priceIds: {} }));
  return app;
}

// Alt Text v2 get_auth_headers(): X-Site-Hash + X-Site-Key (same value),
// X-Site-URL, X-Site-Fingerprint, plus X-License-Key and/or a Bearer JWT
// (auth itself happens in the middleware; here req.license/req.user stand in).
function altTextGet(app, { hash, url }) {
  return request(app)
    .get('/billing/subscription')
    .set('X-Site-Hash', hash)
    .set('X-Site-Key', hash)
    .set('X-Site-URL', url)
    .set('X-Site-Fingerprint', 'fp-qa-0001');
}

const OWN_SITE_PLAN = { plan: 'pro', status: 'active', billingCycle: 'month', nextBillingDate: '2026-11-22T00:00:00.000Z', subscriptionId: 'sub_***0001', cancelAtPeriodEnd: false };
const AGENCY_SITE_PLAN = { plan: 'agency', status: 'active', billingCycle: 'year', nextBillingDate: '2027-03-01T00:00:00.000Z', subscriptionId: 'sub_***9999', cancelAtPeriodEnd: true };
const OWN_LICENCE_PLAN = { plan: 'pro', status: 'active', billingCycle: 'monthly', nextBillingDate: null, subscriptionId: 'sub_***0001', cancelAtPeriodEnd: false };

let spies;
beforeEach(() => {
  seed();
  resolveCanonicalSite.mockReset().mockImplementation(fakeResolve);
  selectActiveSiteSubscription.mockReset().mockImplementation(async (_sb, siteId) => (
    tables.site_subscriptions.find((row) => row.site_id === siteId) || null
  ));
  spies = ['info', 'warn', 'error', 'debug'].map((level) => jest.spyOn(logger, level).mockImplementation(() => {}));
});
afterEach(() => jest.restoreAllMocks());
const logText = () => JSON.stringify(spies.map((spy) => spy.mock.calls));
const memberOf = (userId, siteId) => tables.site_memberships.some((m) => m.user_id === userId && m.site_id === siteId);

describe('GET /billing/subscription: callers on their own site', () => {
  test('licence sign-in (X-License-Key) on the caller\'s own site returns that site\'s plan', async () => {
    const res = await altTextGet(buildApp({ license: OWN }), { hash: 'hash-own', url: 'https://own.example' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: OWN_SITE_PLAN });
  });

  test('JWT sign-in (req.user) on the caller\'s own site returns that site\'s plan', async () => {
    const res = await altTextGet(buildApp({ license: OWN, user: OWN }), { hash: 'hash-own', url: 'https://own.example' });
    expect(res.body).toEqual({ success: true, data: OWN_SITE_PLAN });
  });

  test('the site\'s own licence key returns that site\'s plan', async () => {
    const res = await altTextGet(buildApp({ license: AGENCY }), { hash: 'hash-agency', url: 'https://agency-client.example' });
    expect(res.body).toEqual({ success: true, data: AGENCY_SITE_PLAN });
  });

  test('site headers alone (site-key sign-in) get 401', async () => {
    const res = await altTextGet(buildApp({ license: AGENCY, authMethod: 'site' }), { hash: 'hash-agency', url: 'https://agency-client.example' });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ code: 'SIGN_IN_REQUIRED', message: 'Sign in to manage billing.' });
    expect(resolveCanonicalSite).not.toHaveBeenCalled();
  });

  test('a member of a shared site does not see that site\'s plan; they get their own', async () => {
    const res = await altTextGet(buildApp({ license: TEAMMATE, user: TEAMMATE }), { hash: 'hash-agency', url: 'https://agency-client.example' });
    expect(res.body.data).toEqual({ plan: 'free', status: 'active', billingCycle: 'monthly', nextBillingDate: null, subscriptionId: null, cancelAtPeriodEnd: false });
  });

  test('a brand-new site is created for the caller and reports the caller\'s licence plan', async () => {
    const res = await altTextGet(buildApp({ license: OWN }), { hash: 'hash-brand-new', url: 'https://brand-new.example' });
    expect(res.body).toEqual({ success: true, data: OWN_LICENCE_PLAN });
    const fresh = tables.sites.find((row) => row.site_hash === 'hash-brand-new');
    expect(fresh).toMatchObject({ license_key: 'lic-own', owner_user_id: 'acct-own' });
    expect(memberOf('acct-own', fresh.id)).toBe(true);
  });

  test('the full resolve (with the account) still runs for the caller\'s own site', async () => {
    await altTextGet(buildApp({ license: OWN }), { hash: 'hash-own', url: 'https://own.example' });
    expect(resolveCanonicalSite).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ createIfMissing: true, legacyLicenseKey: 'lic-own', account: OWN })
    );
  });
});

describe('GET /billing/subscription: someone else\'s site', () => {
  test('another account\'s site hash does not reveal that site\'s plan; the caller gets their own licence plan', async () => {
    const res = await altTextGet(buildApp({ license: OWN }), { hash: 'hash-agency', url: 'https://own.example' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: OWN_LICENCE_PLAN });
    expect(JSON.stringify(res.body)).not.toContain('Agency');
  });

  test('the lookup does not make the caller a member of that site, so repeating it still reveals nothing', async () => {
    const app = buildApp({ license: OWN, user: OWN });
    await altTextGet(app, { hash: 'hash-agency', url: 'https://own.example' });
    expect(memberOf('acct-own', 'site-agency')).toBe(false);
    const again = await altTextGet(app, { hash: 'hash-agency', url: 'https://own.example' });
    expect(again.body.data).toEqual(OWN_LICENCE_PLAN);
  });

  test('matching someone else\'s site by URL alone reveals nothing either', async () => {
    const app = buildApp({ license: OWN, user: OWN });
    const first = await altTextGet(app, { hash: 'hash-made-up', url: 'https://agency-client.example' });
    expect(first.body.data).toEqual(OWN_LICENCE_PLAN);
    const again = await altTextGet(app, { hash: 'hash-made-up', url: 'https://agency-client.example' });
    expect(again.body.data).toEqual(OWN_LICENCE_PLAN);
    expect(memberOf('acct-own', 'site-agency')).toBe(false);
  });

  test('the direct site-hash fallback (when the resolve fails) is held to the same rule', async () => {
    resolveCanonicalSite.mockResolvedValue({ site: null, error: 'AMBIGUOUS_SITE_MATCH' });
    const res = await altTextGet(buildApp({ license: OWN }), { hash: 'hash-agency', url: 'https://agency-client.example' });
    expect(res.body.data).toEqual(OWN_LICENCE_PLAN);
  });

  test('a caller with no account (API token only) gets 401 and no site lookup', async () => {
    const res = await altTextGet(buildApp({ license: null, authMethod: 'api_token' }), { hash: 'hash-agency', url: 'https://agency-client.example' });
    expect(res.status).toBe(401);
    expect(resolveCanonicalSite).not.toHaveBeenCalled();
  });

  test('logs carry no full subscription id and no raw site hash for the refused lookup', async () => {
    await altTextGet(buildApp({ license: OWN }), { hash: 'hash-agency-0123456789', url: 'https://own.example' });
    await altTextGet(buildApp({ license: OWN }), { hash: 'hash-own', url: 'https://own.example' });
    const text = logText();
    expect(text).not.toMatch(/\bsub_[A-Za-z0-9]{5,}/);
    expect(text).not.toContain('hash-agency-0123456789');
  });
});
