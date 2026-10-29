const logger = require('../../lib/logger');
const rateLimitMiddleware = require('../../middleware/rateLimit');

function makeReq(path, { ip = '198.51.100.7', headers = {}, license = null } = {}) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { path, ip, headers: lower, license, header: (name) => lower[name.toLowerCase()] };
}
function makeRes() {
  return { statusCode: 0, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
}
const blocked = (spy) => spy.mock.calls.filter(([message]) => message === '[rate-limit] blocked');

describe('[rate-limit] blocked log line (middleware/rateLimit.js)', () => {
  let warnSpy;
  const env = { ...process.env };
  beforeEach(() => { warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {}); });
  afterEach(() => { warnSpy.mockRestore(); process.env = { ...env }; });

  test('allowed requests log nothing; a blocked request logs one fixed label with no path, IP, email or key', async () => {
    const limiter = rateLimitMiddleware({ redis: null, perSiteOverride: 2 });
    const path = '/billing/qa-person@example.invalid/QA-FAKE-LICENSE-KEY-0001';
    const headers = { 'X-License-Key': 'QA-FAKE-LICENSE-KEY-0001', 'X-Site-Key': 'site-key-secret-1' };
    const next = jest.fn();
    for (let i = 0; i < 2; i += 1) await limiter(makeReq(path, { headers }), makeRes(), next);
    expect(next).toHaveBeenCalledTimes(2);
    expect(blocked(warnSpy)).toHaveLength(0);

    const res = makeRes();
    await limiter(makeReq(path, { headers }), res, next);
    expect(res.statusCode).toBe(429);
    const lines = blocked(warnSpy);
    expect(lines).toHaveLength(1);
    expect(lines[0][1]).toEqual({ limiter: 'api-licence-or-ip', limit: 2, window_seconds: 60 });
    expect(JSON.stringify(warnSpy.mock.calls)).not.toMatch(/example\.invalid|QA-FAKE|site-key-secret|198\.51\.100\.7|\/billing/);
  });

  test('auth limiter uses its own label', async () => {
    process.env.AUTH_RATE_LIMIT_PER_IP = '1';
    const limiter = rateLimitMiddleware({ redis: null });
    const next = jest.fn();
    await limiter(makeReq('/auth/login'), makeRes(), next);
    const res = makeRes();
    await limiter(makeReq('/auth/login'), res, next);
    expect(res.statusCode).toBe(429);
    expect(blocked(warnSpy)[0][1].limiter).toBe('auth-ip');
    expect(JSON.stringify(blocked(warnSpy))).not.toMatch(/198\.51\.100\.7|\/auth/);
  });
});
