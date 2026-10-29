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
    or: () => chainable,
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
    app.use((req, _res, next) => { req.license = { id: 'lic-1', license_key: 'key' }; req.authMethod = 'license'; next(); });
    app.use('/usage', createUsageRouter({ supabase }));
    const res = await request(app).get('/usage/sites').set('X-License-Key', 'key');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PLAN_NOT_SUPPORTED');
  });

  test('returns sites for agency license (empty list mocked)', async () => {
    const supabase = createSupabaseMock('agency');
    const app = express();
    app.use((req, _res, next) => { req.license = { id: 'lic-1', license_key: 'key' }; req.authMethod = 'license'; next(); });
    app.use('/usage', createUsageRouter({ supabase }));
    const res = await request(app).get('/usage/sites').set('X-License-Key', 'key');
    expect(res.status).toBe(200);
    expect(res.body.plan_type).toBe('agency');
  });
});

describe('GET /usage/sites excludes trial rows', () => {
  test('per-site totals for an agency licence only count non-trial usage', async () => {
    const calls = [];
    const usageChain = {
      select() { return usageChain; },
      gte() { return usageChain; },
      lt() { return usageChain; },
      or(filter) { calls.push(filter); return usageChain; },
      eq() { return usageChain; },
      then: (resolve) => resolve({ data: [], error: null })
    };
    const supabase = {
      from: (table) => (table === 'usage_logs'
        ? usageChain
        : createChainableMock({ id: 'lic-1', license_key: 'key', plan: 'agency', status: 'active' }))
    };
    const app = express();
    app.use((req, _res, next) => { req.license = { id: 'lic-1', license_key: 'key' }; req.authMethod = 'license'; next(); });
    app.use('/usage', createUsageRouter({ supabase }));

    const res = await request(app).get('/usage/sites').set('X-License-Key', 'key');

    expect(res.status).toBe(200);
    expect(calls).toContain('is_trial.is.null,is_trial.eq.false');
  });
});
