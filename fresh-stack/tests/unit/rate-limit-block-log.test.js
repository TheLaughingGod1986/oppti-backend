const logger = require('../../lib/logger');
const { recordHit, checkoutRateBuckets } = require('../../lib/checkoutRateLimit');
const { sendSignInRequired } = require('../../lib/signInRequired');

const blockedLines = (spy) => spy.mock.calls.filter(([message]) => message === '[rate-limit] blocked');

describe('[rate-limit] blocked log line', () => {
  let warnSpy;
  const originalLimit = process.env.SIGN_IN_REFUSAL_RATE_LIMIT_PER_15_MIN;
  beforeEach(() => {
    checkoutRateBuckets.clear();
    warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warnSpy.mockRestore();
    if (originalLimit === undefined) delete process.env.SIGN_IN_REFUSAL_RATE_LIMIT_PER_15_MIN;
    else process.env.SIGN_IN_REFUSAL_RATE_LIMIT_PER_15_MIN = originalLimit;
  });

  test('allowed hits log nothing; each blocked hit logs one line with a fixed limiter label only', () => {
    const key = 'checkout:pro:price_pro:site_hash_x:owner@customer-brand.co.uk:198.51.100.7';
    expect(recordHit(key, 2, { limiter: 'checkout' }).allowed).toBe(true);
    expect(recordHit(key, 2, { limiter: 'checkout' }).allowed).toBe(true);
    expect(blockedLines(warnSpy)).toHaveLength(0);

    expect(recordHit(key, 2, { limiter: 'checkout' }).allowed).toBe(false);
    expect(recordHit(key, 2, { limiter: 'checkout' }).allowed).toBe(false);
    const lines = blockedLines(warnSpy);
    expect(lines).toHaveLength(2);
    expect(lines[0][1]).toEqual({ limiter: 'checkout', limit: 2, count: 3, window_seconds: 900 });
    expect(JSON.stringify(lines)).not.toMatch(/198\.51\.100\.7|customer-brand|site_hash_x|price_pro/);
  });

  test('a numeric third argument is still read as the clock', () => {
    const t0 = 1_800_000_000_000;
    expect(recordHit('legacy-key', 1, t0).allowed).toBe(true);
    expect(recordHit('legacy-key', 1, t0 + 1000).allowed).toBe(false);
    expect(recordHit('legacy-key', 1, t0 + 16 * 60 * 1000).allowed).toBe(true);
    expect(blockedLines(warnSpy)[0][1].limiter).toBe('unnamed');
  });

  test('sign-in refusal on a path carrying an email and a key logs neither, nor any path', () => {
    process.env.SIGN_IN_REFUSAL_RATE_LIMIT_PER_15_MIN = '1';
    const rawPath = '/billing/qa-person@example.invalid/QA-FAKE-LICENSE-KEY-0001';
    const req = {
      method: 'GET', baseUrl: '', path: rawPath, originalUrl: `${rawPath}?k=QA-FAKE-LICENSE-KEY-0001`, url: rawPath,
      ip: '192.0.2.44', headers: { 'x-license-key': 'QA-FAKE-LICENSE-KEY-0001' }
    };
    const res = { statusCode: 0, set: jest.fn(), status(code) { this.statusCode = code; return this; }, json: jest.fn() };
    sendSignInRequired(req, res);
    expect(res.statusCode).toBe(401);
    sendSignInRequired(req, res);
    expect(res.statusCode).toBe(429);
    const lines = blockedLines(warnSpy);
    expect(lines).toHaveLength(1);
    expect(lines[0][1]).toEqual({ limiter: 'sign-in-required', limit: 1, count: 2, window_seconds: 900 });
    expect(JSON.stringify(warnSpy.mock.calls)).not.toMatch(/example\.invalid|QA-FAKE|192\.0\.2\.44|\/billing/);
  });
});

describe('[rate-limit] blocked through the auth middleware refusal', () => {
  const express = require('express');
  const request = require('supertest');
  const { authMiddleware } = require('../../middleware/auth');
  const originalLimit = process.env.SIGN_IN_REFUSAL_RATE_LIMIT_PER_15_MIN;

  afterEach(() => {
    if (originalLimit === undefined) delete process.env.SIGN_IN_REFUSAL_RATE_LIMIT_PER_15_MIN;
    else process.env.SIGN_IN_REFUSAL_RATE_LIMIT_PER_15_MIN = originalLimit;
  });

  test('GET /billing/<email>/<key> refused twice: the block line has no path, email or key', async () => {
    checkoutRateBuckets.clear();
    process.env.SIGN_IN_REFUSAL_RATE_LIMIT_PER_15_MIN = '1';
    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {});
    const app = express();
    app.use(authMiddleware({ supabase: null }));
    app.get('*', (_req, res) => res.json({ ok: true }));
    const path = '/billing/qa-person@example.invalid/QA-FAKE-LICENSE-KEY-0001';

    const first = await request(app).get(path);
    const second = await request(app).get(path);
    expect(first.status).toBe(401);
    expect(second.status).toBe(429);

    const lines = blockedLines(warnSpy);
    expect(lines).toHaveLength(1);
    expect(lines[0][1]).toEqual({ limiter: 'sign-in-required', limit: 1, count: 2, window_seconds: 900 });
    expect(JSON.stringify(lines)).not.toMatch(/example\.invalid|QA-FAKE|\/billing/);
    warnSpy.mockRestore();
  });
});
