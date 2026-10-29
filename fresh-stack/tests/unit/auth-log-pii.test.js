// Each auth log line that used to carry a licence key prefix, an email or a
// site URL now logs flags only. JWT_SECRET is read when the module loads.
process.env.JWT_SECRET = 'qa-test-jwt-secret-not-real';
const jwt = require('jsonwebtoken');
const logger = require('../../lib/logger');
const { authMiddleware } = require('../../middleware/auth');

const EMAIL = 'qa-person@example.invalid';
const KEY = 'QA-FAKE-LICENSE-KEY-0001';
const KEY_PREFIX = KEY.substring(0, 8);
const SITE_URL = 'https://shop.customer-brand.co.uk';
const LEAK = /example\.invalid|QA-FAKE|customer-brand|%40|@/;

function makeReq(path, headers = {}) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    path,
    url: `${path}?email=${encodeURIComponent(EMAIL)}&key=${KEY}`,
    originalUrl: `${path}?email=${encodeURIComponent(EMAIL)}&key=${KEY}`,
    query: { email: EMAIL, key: KEY },
    method: 'POST',
    headers: lower,
    header: (name) => lower[name.toLowerCase()] || null
  };
}
function makeRes() {
  return { statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
}

describe('auth log lines carry flags, never key characters, emails or site URLs', () => {
  const env = { ...process.env };
  let spies;
  const allCalls = () => spies.flatMap((spy) => spy.mock.calls);
  const line = (message) => allCalls().find(([m]) => m === message);
  beforeEach(() => {
    delete process.env.ALT_API_TOKEN;
    delete process.env.API_TOKEN;
    spies = ['warn', 'info', 'debug', 'error'].map((level) => jest.spyOn(logger, level).mockImplementation(() => {}));
  });
  afterEach(() => {
    spies.forEach((spy) => spy.mockRestore());
    process.env = { ...env, JWT_SECRET: 'qa-test-jwt-secret-not-real' };
  });

  test('trial accepted logs has_site_url, not the X-Site-URL value', async () => {
    const next = jest.fn();
    await authMiddleware({ supabase: {} })(makeReq('/api/alt-text', {
      'X-Trial-Mode': 'true', 'X-Trial-Site-Hash': 'trial-hash-1', 'X-Site-URL': SITE_URL
    }), makeRes(), next);
    expect(next).toHaveBeenCalled();
    const accepted = line('[Auth] Anonymous trial request accepted');
    expect(accepted[1]).toEqual(expect.objectContaining({ has_site_url: true }));
    expect(accepted[1]).not.toHaveProperty('site_url');
    expect(JSON.stringify(allCalls())).not.toMatch(LEAK);
  });

  test('request-headers debug line and licence validation failure log has_license_key, no key characters', async () => {
    const res = makeRes();
    await authMiddleware({ supabase: {} })(makeReq('/api/alt-text', { 'X-License-Key': KEY }), res, jest.fn());
    expect(res.statusCode).toBe(503);
    const debugLine = line('[Auth] Request headers');
    expect(debugLine[1]).toEqual(expect.objectContaining({ has_license_key: true }));
    expect(debugLine[1]).not.toHaveProperty('X-License-Key');
    const failed = line('[Auth] License validation failed');
    expect(failed[1]).toEqual(expect.objectContaining({ has_license_key: true }));
    expect(failed[1]).not.toHaveProperty('licenseKeyPrefix');
    const logged = JSON.stringify(allCalls());
    expect(logged).not.toContain(KEY_PREFIX);
    expect(logged).not.toContain(KEY.slice(-8));
    expect(logged).not.toMatch(LEAK);
  });

  test('JWT validated logs the user id only, not the email', async () => {
    const token = jwt.sign({ user_id: 'acct-123', email: EMAIL }, process.env.JWT_SECRET);
    const supabase = {
      from: () => ({ select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: { id: 'acct-123', status: 'active' }, error: null }) }) }) })
    };
    const next = jest.fn();
    await authMiddleware({ supabase })(makeReq('/api/alt-text', { Authorization: `Bearer ${token}`, 'X-Site-URL': SITE_URL }), makeRes(), next);
    expect(next).toHaveBeenCalled();
    const validated = line('[Auth] JWT validated');
    expect(validated[1]).toEqual({ user_id: 'acct-123' });
    const logged = JSON.stringify(allCalls());
    expect(logged).not.toContain(token);
    expect(logged).not.toMatch(LEAK);
  });
});
