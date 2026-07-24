const express = require('express');
const request = require('supertest');
const { createAccountDashboardRouter } = require('../../routes/accountDashboard');
const { createAnalyticsRouter } = require('../../routes/analytics');
const { createAccountDashboardService } = require('../../services/accountDashboard');

function createService(overrides = {}) {
  return {
    getDashboard: jest.fn().mockResolvedValue({
      ok: true,
      installations: [],
      subscription: null,
      usage: {
        credits_used: 0,
        credits_included: 15,
        images_optimized: 0,
        period_start: '2026-07-01T00:00:00.000Z',
        period_end: '2026-08-01T00:00:00.000Z'
      },
      credits: { balance: 15 }
    }),
    getSubscriptions: jest.fn().mockResolvedValue([]),
    getSites: jest.fn().mockResolvedValue([]),
    detachSite: jest.fn().mockResolvedValue({ ok: true, site_id: 'site-1' }),
    getPluginStats: jest.fn().mockResolvedValue([]),
    getLicenses: jest.fn().mockResolvedValue([]),
    getInvoices: jest.fn().mockResolvedValue([]),
    getOrganizations: jest.fn().mockResolvedValue([]),
    createOrganization: jest.fn(),
    ...overrides
  };
}

function createApp({ authenticated = true, service = createService(), capture } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.id = 'req-account-test';
    if (authenticated) {
      req.user = {
        id: 'account-1',
        email: 'account@example.com',
        license_key: 'license-1',
        plan: 'free',
        status: 'active'
      };
      req.license = req.user;
      req.authMethod = 'jwt';
    }
    next();
  });
  app.use('/', createAccountDashboardRouter({ service }));
  app.use('/analytics', createAnalyticsRouter({ capture }));
  return app;
}

describe('account dashboard route contracts', () => {
  test('authenticated dashboard requests return the real service payload', async () => {
    const service = createService();
    const response = await request(createApp({ service })).get('/dashboard');

    expect(response.status).toBe(200);
    expect(response.body).toEqual(await service.getDashboard.mock.results[0].value);
    expect(service.getDashboard).toHaveBeenCalledTimes(1);
  });

  test('logged-out account requests return 401 instead of 404', async () => {
    const response = await request(createApp({ authenticated: false })).get('/me/sites');

    expect(response.status).toBe(401);
    expect(response.body.code).toBe('UNAUTHORIZED');
  });

  test.each([
    ['/me/subscriptions', 'subscriptions'],
    ['/me/sites', 'sites'],
    ['/me/licenses', 'licenses'],
    ['/me/invoices', 'invoices'],
    ['/organizations', 'organizations']
  ])('%s returns a successful empty-state response', async (path, key) => {
    const response = await request(createApp()).get(path);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true, [key]: [] });
  });

  test('empty plugin statistics are returned as a bare array for the current frontend contract', async () => {
    const response = await request(createApp()).get('/me/plugins/stats');

    expect(response.status).toBe(200);
    expect(response.body).toEqual([]);
  });

  test('POST /me/sites/detach detaches a connected site', async () => {
    const service = createService();
    const response = await request(createApp({ service }))
      .post('/me/sites/detach')
      .send({ site_id: 'site-1' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true, site_id: 'site-1' });
    expect(service.detachSite).toHaveBeenCalledTimes(1);
  });

  test('organizations compatibility response does not query the retired table', async () => {
    const supabase = { from: jest.fn() };
    const service = createAccountDashboardService({ supabase, getStripe: jest.fn() });

    await expect(service.getOrganizations({ user: { license_key: 'license-1' } })).resolves.toEqual([]);
    expect(supabase.from).not.toHaveBeenCalled();
  });

  test('organization creation reports the retired V2 capability instead of a server error', async () => {
    const service = createAccountDashboardService({ supabase: {}, getStripe: jest.fn() });

    await expect(service.createOrganization()).rejects.toMatchObject({
      status: 410,
      code: 'ORGANIZATIONS_RETIRED'
    });
  });

  test('POST /organizations exposes the retired capability as 410', async () => {
    const service = createAccountDashboardService({ supabase: {}, getStripe: jest.fn() });
    const response = await request(createApp({ service }))
      .post('/organizations')
      .set('X-Request-ID', 'req-account-test')
      .send({ name: 'Legacy agency' });

    expect(response.status).toBe(410);
    expect(response.body).toMatchObject({
      code: 'ORGANIZATIONS_RETIRED'
    });
  });

  test('service failures remain errors and are not converted to empty 200 responses', async () => {
    const error = Object.assign(new Error('database unavailable'), {
      status: 503,
      code: 'SERVICE_UNAVAILABLE'
    });
    const service = createService({ getSites: jest.fn().mockRejectedValue(error) });
    const response = await request(createApp({ service })).get('/me/sites');

    expect(response.status).toBe(503);
    expect(response.body.code).toBe('SERVICE_UNAVAILABLE');
    expect(response.body.message).toBe('Unable to load account data');
  });
});

describe('analytics event route', () => {
  test('submits an authenticated analytics event to the configured recorder', async () => {
    const capture = jest.fn().mockResolvedValue({ ok: true, status: 200 });
    const response = await request(createApp({ capture }))
      .post('/analytics/event')
      .send({ event: 'dashboard_viewed', properties: { page_path: '/dashboard/overview' }, source: 'website' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true });
    expect(capture).toHaveBeenCalledWith({
      event: 'dashboard_viewed',
      distinctId: 'account-1',
      properties: {
        page_path: '/dashboard/overview',
        source: 'website',
        request_id: 'req-account-test'
      }
    });
  });

  test('returns 401 for a logged-out analytics submission', async () => {
    const capture = jest.fn();
    const response = await request(createApp({ authenticated: false, capture }))
      .post('/analytics/event')
      .send({ event: 'dashboard_viewed' });

    expect(response.status).toBe(401);
    expect(capture).not.toHaveBeenCalled();
  });

  test('returns an upstream error when the recorder fails', async () => {
    const response = await request(createApp({
      capture: jest.fn().mockResolvedValue({ ok: false, status: 500 })
    }))
      .post('/analytics/event')
      .send({ event: 'dashboard_viewed' });

    expect(response.status).toBe(502);
    expect(response.body.code).toBe('UPSTREAM_ERROR');
  });
});
