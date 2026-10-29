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

  test('allowed hits log nothing; each blocked hit logs one line with limiter and route only', () => {
    const req = { method: 'POST', baseUrl: '/billing', route: { path: '/checkout' }, path: '/checkout', ip: '198.51.100.7' };
    const key = 'checkout:pro:price_pro:site_hash_x:owner@customer-brand.co.uk:198.51.100.7';
    expect(recordHit(key, 2, { limiter: 'checkout', req }).allowed).toBe(true);
    expect(recordHit(key, 2, { limiter: 'checkout', req }).allowed).toBe(true);
    expect(blockedLines(warnSpy)).toHaveLength(0);

    expect(recordHit(key, 2, { limiter: 'checkout', req }).allowed).toBe(false);
    expect(recordHit(key, 2, { limiter: 'checkout', req }).allowed).toBe(false);
    const lines = blockedLines(warnSpy);
    expect(lines).toHaveLength(2);
    expect(lines[0][1]).toEqual({ limiter: 'checkout', route: 'POST /billing/checkout', limit: 2, count: 3, window_seconds: 900 });
    expect(JSON.stringify(lines)).not.toMatch(/198\.51\.100\.7|customer-brand|site_hash_x|price_pro/);
  });

  test('a numeric third argument is still read as the clock', () => {
    const t0 = 1_800_000_000_000;
    expect(recordHit('legacy-key', 1, t0).allowed).toBe(true);
    expect(recordHit('legacy-key', 1, t0 + 1000).allowed).toBe(false);
    expect(recordHit('legacy-key', 1, t0 + 16 * 60 * 1000).allowed).toBe(true);
    expect(blockedLines(warnSpy)[0][1].limiter).toBe('unnamed');
  });

  test('sign-in refusal limiter logs its name and route, not the caller IP or email', () => {
    process.env.SIGN_IN_REFUSAL_RATE_LIMIT_PER_15_MIN = '1';
    const req = {
      method: 'GET', baseUrl: '/billing', route: { path: '/subscription' }, path: '/subscription',
      ip: '192.0.2.44', headers: { 'x-account-email': 'someone@customer-brand.co.uk' }
    };
    const res = { statusCode: 0, set: jest.fn(), status(code) { this.statusCode = code; return this; }, json: jest.fn() };
    sendSignInRequired(req, res);
    expect(res.statusCode).toBe(401);
    sendSignInRequired(req, res);
    expect(res.statusCode).toBe(429);
    const lines = blockedLines(warnSpy);
    expect(lines).toHaveLength(1);
    expect(lines[0][1]).toEqual(expect.objectContaining({ limiter: 'sign-in-required', route: 'GET /billing/subscription' }));
    expect(JSON.stringify(lines)).not.toMatch(/192\.0\.2\.44|customer-brand/);
  });
});
