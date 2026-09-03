/**
 * Verifies /api/internal-linking is wired into the real app: it must be in
 * PROTECTED_API_PREFIXES so the unmatched-/api guard does not 404 it before the
 * router runs. A request with an invalid body should reach the router (400
 * INVALID_REQUEST), not the guard (404 NOT_FOUND).
 */
const request = require('supertest');

jest.mock('../../middleware/auth', () => ({
  authMiddleware: () => (req, _res, next) => {
    req.license = { id: 'lic-1', license_key: 'mount-test-license', plan: 'pro', status: 'active' };
    req.user = req.license;
    req.authMethod = 'license';
    next();
  },
  extractUserInfo: () => ({ user_id: null, user_email: null, plugin_version: '1.0.0' })
}));

describe('/api/internal-linking mount', () => {
  let createApp;

  beforeEach(() => {
    jest.resetModules();
    process.env.NODE_ENV = 'test';
    jest.clearAllMocks();
    ({ createApp } = require('../../server'));
  });

  test('reaches the router (400 INVALID_REQUEST) rather than the /api guard 404', async () => {
    const app = createApp({ supabaseClient: null, redisClient: null });
    const res = await request(app)
      .post('/api/internal-linking/suggest')
      .set('X-License-Key', 'mount-test-license')
      .set('X-Site-Hash', 'site-hash')
      .send({ source: { url: '/x' } /* missing candidates */ });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_REQUEST');
  });

  test('a genuinely unknown /api route still returns NOT_FOUND', async () => {
    const app = createApp({ supabaseClient: null, redisClient: null });
    const res = await request(app).get('/api/internal-linking-not-a-real-route');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
  });
});
