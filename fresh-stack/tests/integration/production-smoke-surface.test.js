/**
 * Production-facing smoke surface: health/ready/plans/webhook/alt-text auth shape.
 *
 * These tests should not require real OpenAI calls.
 */
const request = require('supertest');

jest.mock('../../middleware/auth', () => ({
  authMiddleware: () => (req, res, next) => {
    const licenseKey = req.header('X-License-Key') || null;
    const authHeader = req.header('Authorization') || null;
    const apiKey = req.header('X-API-Key') || null;

    // For this smoke surface test, emulate the production contract:
    // /api/* must return structured JSON auth errors when credentials are missing.
    if (!licenseKey && !authHeader && !apiKey) {
      return res.status(401).json({
        error: 'INVALID_LICENSE',
        message: 'License key required. Please send X-License-Key header with your license key.',
        hint: 'Check your plugin settings to ensure the license key is configured correctly.'
      });
    }

    req.license = {
      id: 'lic-smoke-1',
      license_key: licenseKey || 'smoke-license',
      email: 'smoke@example.com',
      plan: 'free',
      billing_cycle: 'monthly',
      status: 'active'
    };
    req.user = req.license;
    req.authMethod = licenseKey ? 'license' : (authHeader ? 'jwt' : 'api_token');
    return next();
  },
  extractUserInfo: () => ({ user_id: null, user_email: null, plugin_version: '1.0.0' })
}));

jest.mock('../../services/dashboardStateTruth', () => ({
  buildDashboardStateTruth: jest.fn().mockResolvedValue({
    state: 'SMOKE_SURFACE',
    counts: {},
    canon: true
  })
}));

describe('production smoke surface', () => {
  let createApp;

  beforeEach(() => {
    jest.resetModules();
    process.env.NODE_ENV = 'test';
    jest.clearAllMocks();
    ({ createApp } = require('../../server'));
  });

  test('GET /health returns JSON and no secrets', async () => {
    const app = createApp({ supabaseClient: null, redisClient: null });
    const res = await request(app).get('/health');
    expect(res.headers['content-type']).toMatch(/json/);
    // When supabase is null the health endpoint signals unavailability
    expect([200, 503]).toContain(res.status);
    expect(res.body.runtime).toBeTruthy();
  });

  test('GET /ready returns readiness booleans', async () => {
    const app = createApp({ supabaseClient: null, redisClient: null });
    const res = await request(app).get('/ready');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({
      redis: false,
      redis_required: false,
      supabase: false,
      ready: false
    }));
  });

  test('GET /billing/plans and /api/billing/plans both return JSON success', async () => {
    const app = createApp({ supabaseClient: null, redisClient: null });
    const a = await request(app).get('/billing/plans');
    const b = await request(app).get('/api/billing/plans');
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.success).toBe(true);
    expect(b.body.success).toBe(true);
  });

  test('GET /dashboard/state-truth and /api/dashboard/state-truth both route', async () => {
    const app = createApp({ supabaseClient: null, redisClient: null });
    const a = await request(app).get('/dashboard/state-truth').set('X-License-Key', 'smoke-license');
    const b = await request(app).get('/api/dashboard/state-truth').set('X-License-Key', 'smoke-license');
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body).toEqual(b.body);
  });

  test('GET /billing/info and /api/billing/info both route', async () => {
    const app = createApp({ supabaseClient: null, redisClient: null });
    const a = await request(app).get('/billing/info').set('X-License-Key', 'smoke-license');
    const b = await request(app).get('/api/billing/info').set('X-License-Key', 'smoke-license');
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body).toEqual(b.body);
  });

  test('POST /api/alt-text with missing auth returns JSON error (not HTML)', async () => {
    const app = createApp({ supabaseClient: null, redisClient: null });

    const res = await request(app)
      .post('/api/alt-text')
      .set('Content-Type', 'application/json')
      .send({ image: { base64: 'AA==', width: 1, height: 1, mime_type: 'image/png' } });

    expect(res.headers['content-type']).toMatch(/json/);
    expect(res.status).toBe(401);
    expect(res.body).toEqual(expect.objectContaining({
      error: expect.any(String),
      message: expect.any(String)
    }));
  });

  test('POST /billing/webhook reaches webhook handler (not /api/billing/webhook)', async () => {
    const app = createApp({ supabaseClient: null, redisClient: null });

    const billing = await request(app)
      .post('/billing/webhook')
      .set('Content-Type', 'application/json')
      .send({});

    // Must not be the structured /api NOT_FOUND response shape.
    expect(billing.status).not.toBe(404);

    const apiAlias = await request(app)
      .post('/api/billing/webhook')
      .set('Content-Type', 'application/json')
      .set('X-License-Key', 'smoke-license')
      .send({});

    expect(apiAlias.status).toBe(404);
    expect(apiAlias.body).toEqual(expect.objectContaining({
      success: false,
      code: 'NOT_FOUND',
      error: 'NOT_FOUND'
    }));
  });

  test('unknown /api/not-real returns structured JSON NOT_FOUND', async () => {
    const app = createApp({ supabaseClient: null, redisClient: null });
    const res = await request(app).get('/api/not-real').set('X-License-Key', 'smoke-license');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
  });
});
