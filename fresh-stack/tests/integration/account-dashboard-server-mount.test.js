const request = require('supertest');

const mockService = {
  getDashboard: jest.fn().mockResolvedValue({ ok: true, installations: [], subscription: null, usage: {}, credits: { balance: 0 } }),
  getSubscriptions: jest.fn().mockResolvedValue([]),
  getSites: jest.fn().mockResolvedValue([]),
  getPluginStats: jest.fn().mockResolvedValue([]),
  getLicenses: jest.fn().mockResolvedValue([]),
  getInvoices: jest.fn().mockResolvedValue([]),
  getOrganizations: jest.fn().mockResolvedValue([]),
  createOrganization: jest.fn()
};

jest.mock('../../middleware/auth', () => ({
  authMiddleware: () => (req, _res, next) => {
    req.user = { id: 'account-1', license_key: 'license-1', status: 'active' };
    req.license = req.user;
    req.authMethod = 'jwt';
    next();
  },
  extractUserInfo: () => ({ user_id: null, user_email: null, plugin_version: '1.0.0' })
}));

jest.mock('../../services/accountDashboard', () => ({
  createAccountDashboardService: () => mockService
}));

jest.mock('../../lib/posthog', () => ({
  captureServerEvent: jest.fn().mockResolvedValue({ ok: true, status: 200 }),
  identifyServerUser: jest.fn(),
  aliasServerUser: jest.fn()
}));

jest.mock('../../services/dashboardStateTruth', () => ({
  buildDashboardStateTruth: jest.fn().mockResolvedValue({ state: 'TEST', counts: {} })
}));

describe('production server account route mounting', () => {
  let createApp;

  beforeAll(() => {
    process.env.NODE_ENV = 'test';
    ({ createApp } = require('../../server'));
  });

  test.each([
    ['/dashboard', 200],
    ['/me/subscriptions', 200],
    ['/me/sites', 200],
    ['/me/plugins/stats', 200],
    ['/me/licenses', 200],
    ['/me/invoices', 200],
    ['/organizations', 200]
  ])('GET %s is mounted before the final 404 handler', async (path, expectedStatus) => {
    const response = await request(createApp({ supabaseClient: null, redisClient: null })).get(path);
    expect(response.status).toBe(expectedStatus);
  });

  test('POST /analytics/event is mounted and records the event', async () => {
    const response = await request(createApp({ supabaseClient: null, redisClient: null }))
      .post('/analytics/event')
      .send({ event: 'dashboard_viewed', properties: { page_path: '/dashboard/overview' } });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true });
  });
});
