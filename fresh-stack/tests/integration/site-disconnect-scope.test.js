/**
 * QA P2-1 and P3-3 (29 Oct), Chief's ruling: DELETE /license/sites/:id only
 * ever disconnects the caller's own site.
 * - P2-1: another licence's raw key or row id gives 404 and nothing changes
 *   (no site write, no deactivation, no membership delete, no audit row).
 * - P3-3: an unknown id gives 404 and never falls back to the caller's own
 *   site, including on a single-site licence (siteQuota.js
 *   findLicenseOwnedFallbackSite is no longer used for disconnect).
 * Real auth middleware, licence router and services/site.js over an
 * in-memory Supabase that applies writes.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'qa-test-jwt-secret';

const express = require('express');
const jwt = require('jsonwebtoken');
const request = require('supertest');

const { authMiddleware } = require('../../middleware/auth');
const { createLicenseRouter } = require('../../routes/license');
const logger = require('../../lib/logger');

const A = { id: 'acct-scope-a', license_key: 'QA-FAKE-LICENSE-KEY-SCOPE-A01', plan: 'agency', status: 'active', email: 'scope-a@qa.oppti.dev' };
const B = { id: 'acct-scope-b', license_key: 'QA-FAKE-LICENSE-KEY-SCOPE-B02', plan: 'pro', status: 'active', email: 'scope-b@qa.oppti.dev' };
const RAW_A1 = 'qa-raw-site-key-scope-a1-0001';
const RAW_A2 = 'qa-raw-site-key-scope-a2-0002';
const RAW_B = 'qa-raw-site-key-scope-b-0003';
const SITE_A1 = { id: 'aaaaaaaa-0000-4000-8000-0000000000a1', site_hash: RAW_A1, license_key: A.license_key, owner_user_id: A.id, status: 'active', site_url: 'https://a1-scope.example' };
const SITE_A2 = { id: 'aaaaaaaa-0000-4000-8000-0000000000a2', site_hash: RAW_A2, license_key: A.license_key, owner_user_id: A.id, status: 'active', site_url: 'https://a2-scope.example' };
// B is a single-site licence: the case where the old fallback picked B's
// only site for any id.
const SITE_B = { id: 'bbbbbbbb-0000-4000-8000-0000000000b1', site_hash: RAW_B, license_key: B.license_key, owner_user_id: B.id, status: 'active', site_url: 'https://b-scope.example' };

let tables;
function seed() {
  tables = {
    licenses: [{ ...A }, { ...B }],
    sites: [{ ...SITE_A1 }, { ...SITE_A2 }, { ...SITE_B }],
    site_memberships: [],
    site_audit_logs: []
  };
}

function supabaseMock() {
  return {
    rpc: async () => ({ data: null, error: null }),
    from(table) {
      const filters = [];
      let op = 'select';
      let payload = null;
      const match = (row) => filters.every((f) => f(row));
      const run = () => {
        const rows = tables[table] || (tables[table] = []);
        if (op === 'insert') {
          const added = (Array.isArray(payload) ? payload : [payload]).map((row, i) => ({ id: `${table}-new-${rows.length + i}`, ...row }));
          rows.push(...added);
          return added;
        }
        if (op === 'update') {
          const hit = rows.filter(match);
          hit.forEach((row) => Object.assign(row, payload));
          return hit.map((row) => ({ ...row }));
        }
        if (op === 'delete') {
          const keep = rows.filter((row) => !match(row));
          const gone = rows.length - keep.length;
          tables[table] = keep;
          return new Array(gone).fill({});
        }
        return rows.filter(match).map((row) => ({ ...row }));
      };
      const chain = {
        select() { return chain; },
        insert(p) { op = 'insert'; payload = p; return chain; },
        upsert(p) { op = 'insert'; payload = p; return chain; },
        update(p) { op = 'update'; payload = p; return chain; },
        delete() { op = 'delete'; return chain; },
        eq(column, value) { filters.push((row) => row?.[column] === value); return chain; },
        in(column, values) { filters.push((row) => values.includes(row?.[column])); return chain; },
        is(column, value) { filters.push((row) => (row?.[column] ?? null) === value); return chain; },
        neq() { return chain; }, order() { return chain; }, limit() { return chain; }, not() { return chain; },
        or() { return chain; }, gte() { return chain; }, lte() { return chain; }, ilike() { return chain; },
        maybeSingle() { return Promise.resolve({ data: run()[0] || null, error: null }); },
        single() {
          const row = run()[0] || null;
          return Promise.resolve({ data: row, error: row ? null : { code: 'PGRST116', details: 'The result contains 0 rows', message: 'no rows' } });
        },
        then(resolve, reject) { return Promise.resolve({ data: run(), error: null }).then(resolve, reject); }
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
  return app;
}

const licenceHeaders = (account) => ({ 'Content-Type': 'application/json', 'X-License-Key': account.license_key });
const jwtHeaders = (account) => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${jwt.sign({ user_id: account.id, email: account.email }, process.env.JWT_SECRET)}` });
const del = (app, id, headers) => Object.entries(headers).reduce((r, [k, v]) => r.set(k, v), request(app).delete(`/api/licenses/sites/${encodeURIComponent(id)}`));
const snapshot = () => JSON.stringify({ sites: tables.sites, site_memberships: tables.site_memberships, site_audit_logs: tables.site_audit_logs });
const siteRow = (id) => tables.sites.find((row) => row.id === id);

beforeEach(() => {
  seed();
  ['info', 'warn', 'error', 'debug'].forEach((level) => jest.spyOn(logger, level).mockImplementation(() => {}));
});
afterEach(() => jest.restoreAllMocks());

describe('P2-1: another licence\'s site is never disconnected', () => {
  test.each([
    ['licence key', () => licenceHeaders(A)],
    ['JWT', () => jwtHeaders(A)]
  ])('%s of A with B\'s raw key or B\'s row id: 404, nothing changes', async (_label, headers) => {
    for (const id of [RAW_B, SITE_B.id]) {
      const before = snapshot();
      const res = await del(buildApp(), id, headers());
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('SITE_NOT_FOUND');
      expect(snapshot()).toBe(before);
      expect(siteRow(SITE_B.id)).toMatchObject({ status: 'active', license_key: B.license_key, owner_user_id: B.id });
    }
  });

  test('B\'s site with a membership for A is still not disconnected by A', async () => {
    tables.site_memberships.push({ id: 'm-a-on-b', site_id: SITE_B.id, user_id: A.id });
    const before = snapshot();
    const res = await del(buildApp(), RAW_B, licenceHeaders(A));
    expect(res.status).toBe(404);
    expect(snapshot()).toBe(before);
  });
});

describe('P3-3: an unknown id never falls back to the caller\'s own site', () => {
  test.each([
    ['unknown id', 'not-a-site-of-anyone-0000'],
    ['unknown uuid-shaped id', 'cccccccc-0000-4000-8000-0000000000c1'],
    ['another licence\'s row id', SITE_A1.id],
    ['another licence\'s raw key', RAW_A1]
  ])('single-site licence B, %s: 404 and B\'s only site is untouched', async (_label, id) => {
    const before = snapshot();
    const res = await del(buildApp(), id, licenceHeaders(B));
    expect(res.status).toBe(404);
    expect(snapshot()).toBe(before);
    expect(siteRow(SITE_B.id)).toMatchObject({ status: 'active', license_key: B.license_key });
  });

  test('multi-site licence A, unknown id: 404, neither of A\'s sites changes', async () => {
    const before = snapshot();
    const res = await del(buildApp(), 'not-a-site-of-anyone-0001', licenceHeaders(A));
    expect(res.status).toBe(404);
    expect(snapshot()).toBe(before);
  });
});

describe('own site still disconnects', () => {
  test.each([
    ['licence key, row id', () => licenceHeaders(B), SITE_B.id],
    ['licence key, raw key', () => licenceHeaders(B), RAW_B],
    ['JWT, row id', () => jwtHeaders(B), SITE_B.id],
    ['JWT, raw key', () => jwtHeaders(B), RAW_B]
  ])('%s: 200 and only that site is disconnected', async (_label, headers, id) => {
    const others = JSON.stringify([siteRow(SITE_A1.id), siteRow(SITE_A2.id)]);
    const res = await del(buildApp(), id, headers());
    expect(res.status).toBe(200);
    expect(siteRow(SITE_B.id)).toMatchObject({ license_key: null, owner_user_id: null, status: 'deactivated' });
    expect(JSON.stringify([siteRow(SITE_A1.id), siteRow(SITE_A2.id)])).toBe(others);
    expect(res.text).not.toContain(RAW_B);
  });

  test('multi-site licence A disconnects exactly the named site', async () => {
    const res = await del(buildApp(), SITE_A2.id, licenceHeaders(A));
    expect(res.status).toBe(200);
    expect(siteRow(SITE_A2.id).status).toBe('deactivated');
    expect(siteRow(SITE_A1.id).status).toBe('active');
    expect(siteRow(SITE_B.id).status).toBe('active');
  });
});
