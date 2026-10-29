const express = require('express');
const request = require('supertest');
const { safeLogPath, looksLikeKey } = require('../../lib/logPath');

const EMAIL = 'qa-person@example.invalid';
const KEY = 'QA-FAKE-LICENSE-KEY-0001';
const UUID_KEY = '3f2b8c1e-9a4d-4e7b-8f10-2c5d6e7f8a9b';
const LEAK = /example\.invalid|QA-FAKE|3f2b8c1e|%40|@|token-value|email=|key=/;

describe('safeLogPath', () => {
  test.each([
    ['/api/not-a-real-endpoint', '/api/not-a-real-endpoint'],
    ['/api/not-a-real-endpoint?email=a@b.c&key=x', '/api/not-a-real-endpoint'],
    ['/api/usage/trial-batch-plan', '/api/usage/trial-batch-plan'],
    ['/api/review', '/api/review'],
    ['/billing/plans', '/billing/plans'],
    ['/api/billing/plans/', '/api/billing/plans'],
    ['/BILLING/HEALTH', '/billing/health'],
    [`/billing/${EMAIL}/${KEY}`, 'other'],
    ['/billing/checkout', 'other'],
    ['/api/billing/portal', 'other'],
    ['/license/anything', 'other'],
    ['/api/licenses/x', 'other'],
    ['/auth/reset', 'other'],
    ['/api/auth/login', 'other'],
    ['/api/x/qa-person%40example.invalid', 'other'],
    ['/api/x/a@b', 'other'],
    [`/api/x/${KEY}`, 'other'],
    [`/api/x/${UUID_KEY}`, 'other'],
    ['/api/' + 'a'.repeat(250), 'other'],
    ['', 'other'],
    [null, 'other']
  ])('%s -> %s', (input, expected) => {
    expect(safeLogPath(input)).toBe(expected);
  });

  test('plain route words are not treated as keys', () => {
    expect(looksLikeKey('trial-batch-plan')).toBe(false);
    expect(looksLikeKey('image-seo-audit')).toBe(false);
    expect(looksLikeKey('v1')).toBe(false);
    expect(looksLikeKey(KEY)).toBe(true);
  });
});

describe('server unmatched_route and review post log lines', () => {
  let warnSpy;
  let infoSpy;
  let logger;
  const loggedCalls = () => [...warnSpy.mock.calls, ...infoSpy.mock.calls];

  beforeEach(() => {
    jest.resetModules();
    process.env.NODE_ENV = 'test';
    jest.doMock('../../middleware/auth', () => ({
      authMiddleware: () => (req, res, next) => { req.authMethod = 'license'; next(); },
      extractUserInfo: () => ({})
    }));
    logger = require('../../lib/logger');
    warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {});
    infoSpy = jest.spyOn(logger, 'info').mockImplementation(() => {});
  });
  afterEach(() => {
    warnSpy.mockRestore();
    infoSpy.mockRestore();
    jest.dontMock('../../middleware/auth');
  });

  const unmatched = () => warnSpy.mock.calls.filter(([m]) => m === '[api] unmatched_route').map(([, ctx]) => ctx);

  test.each([
    // first handler: /api/* outside the protected prefixes
    [`/api/nope/${encodeURIComponent(EMAIL)}/${KEY}?email=${encodeURIComponent(EMAIL)}&token=token-value`, 'other'],
    [`/api/nope/${UUID_KEY}`, 'other'],
    ['/api/not-a-real-endpoint?email=qa-person%40example.invalid&key=QA-FAKE-LICENSE-KEY-0001', '/api/not-a-real-endpoint'],
    // final handler: unmatched path under a protected prefix
    [`/api/dashboard/nope/${encodeURIComponent(EMAIL)}?key=${KEY}`, 'other'],
    ['/api/dashboard/no-such-page?email=qa-person%40example.invalid', '/api/dashboard/no-such-page']
  ])('GET %s logs path %s with no originalUrl or query', async (url, expectedPath) => {
    const { createApp } = require('../../server');
    const app = createApp({ supabaseClient: null, redisClient: null });
    const res = await request(app).get(url);
    expect(res.status).toBe(404);
    const lines = unmatched();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toEqual({ method: 'GET', path: expectedPath });
    expect(JSON.stringify(loggedCalls())).not.toMatch(LEAK);
  });

  test('review post logs the mount path without the query', async () => {
    jest.doMock('../../lib/openai', () => ({ reviewAltText: jest.fn().mockResolvedValue({ score: 8 }) }));
    const { createReviewRouter } = require('../../routes/review');
    const app = express();
    app.use(express.json());
    app.use('/api/review', createReviewRouter({ supabase: null }));
    await request(app).post(`/api/review?email=${encodeURIComponent(EMAIL)}&key=${KEY}`).send({});
    const post = infoSpy.mock.calls.find(([m]) => m === '[review] post');
    expect(post[1]).toEqual({ path: '/api/review', authMethod: null });
    expect(JSON.stringify(loggedCalls())).not.toMatch(LEAK);
    jest.dontMock('../../lib/openai');
  });
});
