const express = require('express');
const request = require('supertest');
const { createUsageRouter } = require('../../routes/usage');

/**
 * Creates a chainable mock that supports all Supabase query methods.
 */
function createChainableMock(resolveData = null, resolveError = null) {
  const chainable = {
    select: () => chainable,
    eq: () => chainable,
    neq: () => chainable,
    gt: () => chainable,
    gte: () => chainable,
    lt: () => chainable,
    lte: () => chainable,
    like: () => chainable,
    ilike: () => chainable,
    is: () => chainable,
    in: () => chainable,
    order: () => chainable,
    limit: () => chainable,
    single: () => Promise.resolve({ data: resolveData, error: resolveError }),
    maybeSingle: () => Promise.resolve({ data: resolveData, error: resolveError }),
    then: (resolve) => resolve({ data: resolveData ? [resolveData] : [], error: resolveError })
  };
  return chainable;
}

function createSupabaseMock(plan = 'agency') {
  return {
    from: (table) => {
      if (table === 'licenses') {
        return createChainableMock({ id: 'lic-1', license_key: 'key', plan, status: 'active' });
      }
      if (table === 'usage_logs') {
        return createChainableMock(null); // Empty usage logs
      }
      return createChainableMock(null);
    }
  };
}

describe('GET /usage/sites', () => {
  test('rejects non-agency license', async () => {
    const supabase = createSupabaseMock('pro');
    const app = express();
    app.use('/usage', createUsageRouter({ supabase }));
    const res = await request(app).get('/usage/sites').set('X-License-Key', 'key');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PLAN_NOT_SUPPORTED');
  });

  test('returns sites for agency license (empty list mocked)', async () => {
    const supabase = createSupabaseMock('agency');
    const app = express();
    app.use('/usage', createUsageRouter({ supabase }));
    const res = await request(app).get('/usage/sites').set('X-License-Key', 'key');
    expect(res.status).toBe(200);
    expect(res.body.plan_type).toBe('agency');
  });
});

describe('usage responses never carry the raw site key', () => {
  const RAW = 'qa-raw-site-key-usage-0001';
  const { installIdFromSiteKey } = require('../../lib/installId');
  function appWith(usageRow) {
    const supabase = {
      from: (table) => (table === 'licenses'
        ? createChainableMock({ id: 'lic-1', license_key: 'key', plan: 'agency', status: 'active' })
        : createChainableMock(usageRow))
    };
    const app = express();
    app.use((req, res, next) => { req.license = { id: 'lic-1', license_key: 'key' }; req.authMethod = 'license'; next(); });
    app.use('/usage', createUsageRouter({ supabase }));
    return app;
  }

  test('/usage/users returns the hashed install id, not the X-Site-Key value', async () => {
    const res = await request(appWith({ user_email: 'u@example.invalid', user_id: 7, credits_used: 2, created_at: '2026-10-01T00:00:00Z' }))
      .get('/usage/users').set('X-License-Key', 'key').set('X-Site-Key', RAW);
    expect(res.status).toBe(200);
    expect(res.body.site_install_id).toBe(installIdFromSiteKey(RAW));
    expect(res.body).not.toHaveProperty('site_id');
    expect(JSON.stringify(res.body)).not.toContain(RAW);
  });

  test('/usage/sites returns per-site hashed install ids, not stored site_hash values', async () => {
    const res = await request(appWith({ site_hash: RAW, credits_used: 3, created_at: '2026-10-01T00:00:00Z' }))
      .get('/usage/sites').set('X-License-Key', 'key');
    expect(res.status).toBe(200);
    expect(res.body.sites).toEqual([expect.objectContaining({ site_install_id: installIdFromSiteKey(RAW), credits_used: 3 })]);
    expect(res.body.sites[0]).not.toHaveProperty('site_hash');
    expect(JSON.stringify(res.body)).not.toContain(RAW);
  });
});
