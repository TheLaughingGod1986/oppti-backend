const logger = require('../../lib/logger');
const { authMiddleware } = require('../../middleware/auth');

const EMAIL = 'qa-person@example.invalid';
const KEY = 'QA-FAKE-LICENSE-KEY-0001';
const BILLING_PATH = `/billing/${EMAIL}/${KEY}`;
const LEAK = /example\.invalid|QA-FAKE|%40|\/billing/;

function makeReq(path, headers = {}) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    path,
    url: `${path}?email=${encodeURIComponent(EMAIL)}&key=${KEY}`,
    originalUrl: `${path}?email=${encodeURIComponent(EMAIL)}&key=${KEY}`,
    query: { email: EMAIL, key: KEY },
    method: 'GET',
    headers: lower,
    header: (name) => lower[name.toLowerCase()] || null
  };
}
function makeRes() {
  return { statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
}

describe('auth middleware logs never include the request path or query', () => {
  const env = { ...process.env };
  let spies;
  const allCalls = () => spies.flatMap((spy) => spy.mock.calls);
  beforeEach(() => {
    delete process.env.ALT_API_TOKEN;
    delete process.env.API_TOKEN;
    spies = ['warn', 'info', 'debug', 'error'].map((level) => jest.spyOn(logger, level).mockImplementation(() => {}));
  });
  afterEach(() => {
    spies.forEach((spy) => spy.mockRestore());
    process.env = { ...env };
  });

  test('a /billing/<email>/<key> request without credentials logs a fixed reason and neither the email nor the key', async () => {
    const res = makeRes();
    const next = jest.fn();
    await authMiddleware({ supabase: {} })(makeReq(BILLING_PATH), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    const line = allCalls().find(([message]) => message === '[Auth] No license key or API token provided');
    expect(line).toBeDefined();
    expect(line[1]).toEqual(expect.objectContaining({ reason: 'missing_credentials', method: 'GET' }));
    for (const key of ['path', 'url', 'originalUrl', 'query']) expect(line[1]).not.toHaveProperty(key);
    expect(JSON.stringify(allCalls())).not.toMatch(LEAK);
  });

  test('an invalid bearer token on /billing/<email>/<key> logs the path as other', async () => {
    const res = makeRes();
    await authMiddleware({ supabase: {} })(makeReq(BILLING_PATH, { Authorization: 'Bearer not-a-real-jwt' }), res, jest.fn());
    expect(res.statusCode).toBe(401);
    const line = allCalls().find(([message]) => message === '[Auth] JWT validation failed');
    expect(line).toBeDefined();
    expect(line[1].path).toBe('other');
    expect(JSON.stringify(allCalls())).not.toMatch(LEAK);
  });

  test('trial headers on /billing/<email>/<key> log the path as other', async () => {
    await authMiddleware({ supabase: {} })(makeReq(BILLING_PATH, { 'X-Trial-Mode': 'true', 'X-Trial-Site-Hash': 'h1' }), makeRes(), jest.fn());
    const line = allCalls().find(([message]) => message === '[Auth] Anonymous trial headers present but not activated');
    expect(line).toBeDefined();
    expect(line[1]).toEqual(expect.objectContaining({ path: 'other', reason: 'unsupported_path' }));
    expect(JSON.stringify(allCalls())).not.toMatch(LEAK);
  });

  test('known fixed routes keep their name in the log label', async () => {
    await authMiddleware({ supabase: {} })(makeReq('/api/alt-text', { 'X-Trial-Mode': 'true', 'X-License-Key': KEY, 'X-Trial-Site-Hash': 'h1' }), makeRes(), jest.fn());
    const line = allCalls().find(([message]) => message === '[Auth] Anonymous trial headers present but not activated');
    expect(line[1].path).toBe('/api/alt-text');
  });
});
