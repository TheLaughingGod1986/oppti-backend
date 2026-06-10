/**
 * /api aliases for dashboard and billing routers — same payloads as non-/api mounts.
 */
const request = require('supertest');

jest.mock('../../middleware/auth', () => ({
  authMiddleware: () => (req, res, next) => {
    req.license = {
      id: 'lic-1',
      license_key: 'alias-test-license',
      email: 'a@example.com',
      plan: 'pro',
      billing_cycle: 'monthly',
      stripe_customer_id: 'cus_test',
      stripe_subscription_id: 'sub_test',
      status: 'active'
    };
    req.user = req.license;
    req.authMethod = 'license';
    next();
  },
  extractUserInfo: () => ({ user_id: null, user_email: null, plugin_version: '1.0.0' })
}));

jest.mock('../../services/dashboardStateTruth', () => ({
  buildDashboardStateTruth: jest.fn().mockResolvedValue({
    state: 'ALIAS_ROUTE_TEST',
    counts: {},
    canon: true
  })
}));

describe('API route aliases (/api/dashboard, /api/billing)', () => {
  let createApp;

  beforeEach(() => {
    jest.resetModules();
    process.env.NODE_ENV = 'test';
    jest.clearAllMocks();
    ({ createApp } = require('../../server'));
  });

  test('GET /dashboard/state-truth matches GET /api/dashboard/state-truth payload', async () => {
    const { buildDashboardStateTruth } = require('../../services/dashboardStateTruth');
    const app = createApp({ supabaseClient: null, redisClient: null });

    const a = await request(app)
      .get('/dashboard/state-truth')
      .set('X-License-Key', 'alias-test-license');

    const b = await request(app)
      .get('/api/dashboard/state-truth')
      .set('X-License-Key', 'alias-test-license');

    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body).toEqual(b.body);
    expect(buildDashboardStateTruth).toHaveBeenCalledTimes(2);
  });

  test('GET /billing/info matches GET /api/billing/info payload', async () => {
    const app = createApp({ supabaseClient: null, redisClient: null });

    const a = await request(app)
      .get('/billing/info')
      .set('X-License-Key', 'alias-test-license');

    const b = await request(app)
      .get('/api/billing/info')
      .set('X-License-Key', 'alias-test-license');

    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body).toEqual(b.body);
    expect(a.body.success).toBe(true);
  });

  test('POST /billing/checkout matches POST /api/billing/checkout validation payload', async () => {
    const app = createApp({ supabaseClient: null, redisClient: null });
    const payload = { priceId: 'price_not_configured' };

    const a = await request(app)
      .post('/billing/checkout')
      .set('X-License-Key', 'alias-test-license')
      .set('X-Site-Key', 'site-hash-1')
      .send(payload);

    const b = await request(app)
      .post('/api/billing/checkout')
      .set('X-License-Key', 'alias-test-license')
      .set('X-Site-Key', 'site-hash-1')
      .send(payload);

    expect(a.status).toBe(400);
    expect(b.status).toBe(400);
    expect(a.body).toEqual(b.body);
  });

  test('unknown /api/foo returns structured NOT_FOUND JSON', async () => {
    const app = createApp({ supabaseClient: null, redisClient: null });

    const res = await request(app).get('/api/will-never-be-a-real-route-xyz');

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.code).toBe('NOT_FOUND');
    expect(res.body.error).toBe('NOT_FOUND');
    expect(typeof res.body.message).toBe('string');
  });
});
