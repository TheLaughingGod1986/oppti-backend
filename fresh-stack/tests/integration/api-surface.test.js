/**
 * Plugin-facing API surface: review, billing plans aliases, JSON 404s.
 */
const express = require('express');
const request = require('supertest');

jest.mock('../../lib/openai', () => ({
  reviewAltText: jest.fn().mockResolvedValue({
    score: 8,
    feedback: 'ok',
    usage: { total_tokens: 5 }
  })
}));

jest.mock('../../middleware/auth', () => ({
  authMiddleware: () => (req, res, next) => {
    req.license = {
      license_key: 'review-test-key',
      plan: 'pro',
      status: 'active'
    };
    req.authMethod = 'license';
    next();
  },
  extractUserInfo: () => ({})
}));

const { getBillingPlansJson } = require('../../services/billingPlansCatalog');
const { createReviewRouter } = require('../../routes/review');
const rateLimitMiddleware = require('../../middleware/rateLimit');

function buildApiTestApp() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  const priceIds = { pro: 'price_pro', agency: 'price_agency', credits: 'price_credits' };

  app.get('/api/billing/plans', (req, res) => {
    res.json(getBillingPlansJson(priceIds));
  });

  app.use(rateLimitMiddleware({ redis: null, perSiteOverride: 120, globalOverride: 0 }));
  app.use(require('../../middleware/auth').authMiddleware({ supabase: {} }));
  app.use('/api/review', createReviewRouter());

  app.use((req, res) => {
    if (res.headersSent) return;
    if (req.path.startsWith('/api')) {
      return res.status(404).json({
        success: false,
        error: 'NOT_FOUND',
        code: 'NOT_FOUND',
        message: `Cannot ${req.method} ${req.originalUrl}`
      });
    }
    res.status(404).send('Not Found');
  });

  return app;
}

describe('API surface (plugin contracts)', () => {
  test('POST /api/review returns JSON success and never HTML', async () => {
    const app = buildApiTestApp();
    const res = await request(app)
      .post('/api/review')
      .set('X-License-Key', 'review-test-key')
      .send({
        altText: 'A photo of a cat',
        image: {
          url: 'https://example.com/cat.jpg',
          width: 100,
          height: 100,
          filename: 'cat.jpg'
        }
      });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/json/);
    expect(res.body.success).toBe(true);
    expect(res.body.review).toBeTruthy();
    expect(res.text).not.toMatch(/<!DOCTYPE/i);
  });

  test('POST /api/review returns structured JSON validation error', async () => {
    const app = buildApiTestApp();
    const res = await request(app)
      .post('/api/review')
      .set('X-License-Key', 'review-test-key')
      .send({});

    expect(res.status).toBe(400);
    expect(res.headers['content-type']).toMatch(/json/);
    expect(res.body.error).toBe('INVALID_REQUEST');
    expect(res.text).not.toMatch(/<!DOCTYPE/i);
  });

  test('GET /api/billing/plans returns cached-style payload quickly', async () => {
    const app = buildApiTestApp();
    const t0 = Date.now();
    const res = await request(app).get('/api/billing/plans');
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.plans)).toBe(true);
    expect(res.body.plans.length).toBeGreaterThanOrEqual(3);
  });

  test('GET /api/not-a-real-endpoint returns JSON 404 not HTML', async () => {
    const app = buildApiTestApp();
    const res = await request(app).get('/api/not-a-real-endpoint');
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/json/);
    expect(res.body.code).toBe('NOT_FOUND');
    expect(res.text).not.toMatch(/<!DOCTYPE/i);
  });
});

describe('billingPlansCatalog', () => {
  test('getBillingPlansJson returns stable shape', () => {
    const j = getBillingPlansJson({ pro: 'x', agency: 'y', credits: 'z' });
    expect(j.success).toBe(true);
    expect(j.plans[0].priceId).toBe('x');
  });
});
