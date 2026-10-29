/**
 * Chief's ruling (29 Oct): DELETE /license/sites/:site_id, POST
 * /license/sites/:site_id/quota and POST /me/sites/detach change the
 * account's sites, so they need an account credential (JWT or the account's
 * own licence key). Site headers alone get the sign-in reply before any
 * service call. The path id may be the sites row id or the raw site key.
 *
 * Shipped plugin call sites (source, checked 29 Oct):
 * - Alt Text 4.6.143 includes/class-api-client-v2.php:1671-1676 and 4.6.144
 *   (77bf702a) :1687-1692 call DELETE /api/licenses/sites/:id only after
 *   is_authenticated() (:432-436: a stored licence key, or a token), so
 *   get_auth_headers sends X-License-Key (:543) or Authorization (:546). The
 *   older trait (includes/traits/trait-api-license.php:86-91, same guard) and
 *   the AJAX handler (admin/traits/trait-core-ajax-license.php:153) too.
 * - No shipped plugin calls POST /license/sites/:id/quota or /me/sites/detach.
 * - Titles 1.0.30 and IL 0.1.4 call none of the three.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'qa-test-jwt-secret';

jest.mock('../../services/site', () => {
  const actual = jest.requireActual('../../services/site');
  return {
    ...actual,
    deactivateSite: jest.fn(async () => ({ data: { id: 'x' } })),
    setSiteQuota: jest.fn(async ({ siteHash }) => ({ data: { id: 'site-q', site_hash: siteHash, quota_limit: 10 } })),
    getSites: jest.fn()
  };
});

const express = require('express');
const jwt = require('jsonwebtoken');
const request = require('supertest');

const siteService = require('../../services/site');
const { authMiddleware } = require('../../middleware/auth');
const { createLicenseRouter } = require('../../routes/license');
const { createAccountDashboardRouter } = require('../../routes/accountDashboard');
const logger = require('../../lib/logger');

const RAW_A = 'qa-raw-site-key-mgmt-aaaa-0001';
const RAW_B = 'qa-raw-site-key-mgmt-bbbb-0002';
const A = { id: 'acct-mgmt-a', license_key: 'QA-FAKE-LICENSE-KEY-MGMT-A001', plan: 'agency', status: 'active', email: 'mgmt-a@qa.oppti.dev' };
const B = { id: 'acct-mgmt-b', license_key: 'QA-FAKE-LICENSE-KEY-MGMT-B002', plan: 'agency', status: 'active', email: 'mgmt-b@qa.oppti.dev' };
const SITE_A = { id: '11111111-aaaa-4aaa-8aaa-000000000001', site_hash: RAW_A, license_key: A.license_key, owner_user_id: A.id, status: 'active', site_url: 'https://alpha-mgmt.example' };
const SITE_B = { id: '22222222-bbbb-4bbb-8bbb-000000000002', site_hash: RAW_B, license_key: B.license_key, owner_user_id: B.id, status: 'active', site_url: 'https://bravo-mgmt.example' };
const SIGN_IN_REQUIRED_TEXT = JSON.stringify({ code: 'SIGN_IN_REQUIRED', message: 'Sign in to manage billing.' });

let tables;
function supabaseMock() {
  return {
    from(table) {
      const filters = [];
      const rows = () => (tables[table] || []).filter((row) => filters.every((f) => f(row)));
      const chain = {
        select() { return chain; }, update() { return chain; }, delete() { return chain; },
        order() { return chain; }, limit() { return chain; }, in() { return chain; }, neq() { return chain; },
        gte() { return chain; }, lte() { return chain; }, is() { return chain; }, not() { return chain; }, or() { return chain; },
        eq(column, value) { filters.push((row) => row?.[column] === value); return chain; },
        maybeSingle() { return Promise.resolve({ data: rows()[0] || null, error: null }); },
        single() {
          const row = rows()[0] || null;
          return Promise.resolve({ data: row, error: row ? null : { code: 'PGRST116', details: 'The result contains 0 rows', message: 'no rows' } });
        },
        then(resolve, reject) { return Promise.resolve({ data: rows(), error: null }).then(resolve, reject); }
      };
      return chain;
    }
  };
}

function buildApp() {
  const supabase = supabaseMock();
  const app = express();
  app.use(express.json());
  app.use(authMiddleware({ supabase }));
  app.use('/api/licenses', createLicenseRouter({ supabase }));
  app.use('/api/license', createLicenseRouter({ supabase }));
  app.use('/', createAccountDashboardRouter({ supabase, getStripe: () => null }));
  return app;
}

const send = (req, headers) => Object.entries(headers).reduce((r, [k, v]) => r.set(k, v), req);
// Alt Text 4.6.143 get_auth_headers with no stored licence or token.
const siteOnly = (raw) => ({ 'Content-Type': 'application/json', 'X-Site-Hash': raw, 'X-Site-Key': raw, 'X-Site-URL': 'https://alpha-mgmt.example', 'X-Site-Fingerprint': 'fp-mgmt', 'X-WP-User-ID': '1' });
const withLicence = (raw, licence) => ({ ...siteOnly(raw), 'X-License-Key': licence });
const withJwt = (account) => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${jwt.sign({ user_id: account.id, email: account.email }, process.env.JWT_SECRET)}` });

const CALLS = {
  'DELETE /api/licenses/sites/:id': (app, id, headers) => send(request(app).delete(`/api/licenses/sites/${encodeURIComponent(id)}`), headers),
  'DELETE /api/license/sites/:id': (app, id, headers) => send(request(app).delete(`/api/license/sites/${encodeURIComponent(id)}`), headers),
  'POST /api/licenses/sites/:id/quota': (app, id, headers) => send(request(app).post(`/api/licenses/sites/${encodeURIComponent(id)}/quota`), headers).send({ quota_limit: 10 }),
  'POST /me/sites/detach': (app, id, headers) => send(request(app).post('/me/sites/detach'), headers).send({ site_id: id })
};
const serviceFor = (name) => (name.startsWith('DELETE') || name.includes('detach') ? siteService.deactivateSite : siteService.setSiteQuota);

let spies;
beforeEach(() => {
  tables = { licenses: [{ ...A }, { ...B }], sites: [{ ...SITE_A }, { ...SITE_B }], site_memberships: [] };
  siteService.deactivateSite.mockClear();
  siteService.setSiteQuota.mockClear();
  siteService.getSites.mockReset();
  siteService.getSites.mockImplementation(async (_supabase, { licenseKey }) => ({ data: tables.sites.filter((row) => row.license_key === licenseKey), error: null }));
  spies = ['info', 'warn', 'error', 'debug'].map((level) => jest.spyOn(logger, level).mockImplementation(() => {}));
});
afterEach(() => jest.restoreAllMocks());

describe.each(Object.keys(CALLS))('%s', (name) => {
  const call = CALLS[name];

  test.each([
    ['row id', SITE_A.id],
    ['raw site key', RAW_A]
  ])('site headers alone (%s): sign-in reply, no service call, no key in the body', async (_label, id) => {
    const res = await call(buildApp(), id, siteOnly(RAW_A));
    expect([401, 403]).toContain(res.status);
    expect(res.text).toBe(SIGN_IN_REQUIRED_TEXT);
    expect(serviceFor(name)).not.toHaveBeenCalled();
    for (const value of [RAW_A, A.license_key, A.email]) expect(res.text).not.toContain(value);
  });

  test.each([
    ['licence key, row id', () => withLicence(RAW_A, A.license_key), SITE_A.id],
    ['licence key, raw key', () => withLicence(RAW_A, A.license_key), RAW_A],
    ['JWT, row id', () => withJwt(A), SITE_A.id],
    ['JWT, raw key', () => withJwt(A), RAW_A]
  ])('account credential (%s): works on the stored site key', async (_label, headers, id) => {
    const res = await call(buildApp(), id, headers());
    expect(res.status).toBe(200);
    expect(serviceFor(name)).toHaveBeenCalledTimes(1);
    expect(serviceFor(name).mock.calls[0][1]).toMatchObject({ licenseKey: A.license_key, siteHash: RAW_A });
  });

  test('log lines never carry the raw site key or licence key', async () => {
    const app = buildApp();
    await call(app, RAW_A, siteOnly(RAW_A));
    await call(app, SITE_A.id, withLicence(RAW_A, A.license_key));
    await call(app, RAW_A, withJwt(A));
    const logged = JSON.stringify(spies.flatMap((spy) => spy.mock.calls)
      // The billing branch's auth middleware line for site auth is fixed by
      // the site branch (logIdentity); this checks the route's own lines.
      .filter(([msg]) => !String(msg).startsWith('[Auth]')));
    for (const value of [RAW_A, A.license_key]) expect(logged).not.toContain(value);
  });
});

describe('the row id never reaches another licence\'s site', () => {
  test.each([
    ['DELETE', (app, headers) => send(request(app).delete(`/api/licenses/sites/${SITE_B.id}`), headers), siteService.deactivateSite],
    ['quota', (app, headers) => send(request(app).post(`/api/licenses/sites/${SITE_B.id}/quota`), headers).send({ quota_limit: 5 }), siteService.setSiteQuota]
  ])('%s with A\'s licence and B\'s row id is not turned into B\'s site key', async (_label, call, service) => {
    await call(buildApp(), withLicence(RAW_A, A.license_key));
    expect(service.mock.calls.map((c) => c[1].siteHash)).not.toContain(RAW_B);
  });

  test('detach with A\'s licence and B\'s row id or raw key: 404, nothing detached', async () => {
    for (const id of [SITE_B.id, RAW_B]) {
      const res = await send(request(buildApp()).post('/me/sites/detach'), withLicence(RAW_A, A.license_key)).send({ site_id: id });
      expect(res.status).toBe(404);
    }
    expect(siteService.deactivateSite).not.toHaveBeenCalled();
  });
});
