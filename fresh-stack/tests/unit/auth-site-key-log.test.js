const logger = require('../../lib/logger');
jest.mock('../../services/license', () => ({ validateLicense: jest.fn() }));
const { validateLicense } = require('../../services/license');
const { authMiddleware } = require('../../middleware/auth');
const { storedSiteHashForLog } = require('../../lib/logPath');

const KEY = 'QA-FAKE-LICENSE-KEY-0001';
const RAW_SITE_KEY = 'qa-raw-site-key-secret-0001';

function makeReq(path, headers = {}) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { path, method: 'POST', headers: lower, body: {}, header: (name) => lower[name.toLowerCase()] || null };
}
function makeRes() {
  return { statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
}
function sitesSupabase(siteRow) {
  return {
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: siteRow, error: null }) }) }) })
  };
}

describe('auth log lines never carry the raw site key', () => {
  const env = { ...process.env };
  let spies;
  const allCalls = () => spies.flatMap((spy) => spy.mock.calls);
  const line = (message) => allCalls().find(([m]) => m === message);
  beforeEach(() => {
    delete process.env.ALT_API_TOKEN;
    delete process.env.API_TOKEN;
    spies = ['warn', 'info', 'debug', 'error'].map((level) => jest.spyOn(logger, level).mockImplementation(() => {}));
  });
  afterEach(() => { spies.forEach((spy) => spy.mockRestore()); process.env = { ...env }; jest.clearAllMocks(); });

  const expectNoRawKey = () => {
    const logged = JSON.stringify(allCalls());
    expect(logged).not.toContain(RAW_SITE_KEY);
    expect(logged).not.toContain(KEY.substring(0, 8));
    expect(logged).not.toContain(KEY.slice(-8));
  };

  test.each([
    ['stored site_hash equals the sent key', RAW_SITE_KEY, null],
    ['site row has no site_hash', null, null],
    ['stored site_hash differs from the sent key', 'stored-hash-abc', 'stored-hash-abc']
  ])('Site-key resolved license invalid (%s)', async (_label, storedHash, expectedHash) => {
    validateLicense.mockResolvedValue({ error: 'LICENSE_EXPIRED' });
    await authMiddleware({ supabase: sitesSupabase({ status: 'active', license_key: KEY, site_hash: storedHash }) })(
      makeReq('/api/alt-text', { 'X-Site-Key': RAW_SITE_KEY }), makeRes(), jest.fn()
    );
    const warn = line('[Auth] Site-key resolved license invalid');
    expect(warn[1]).toEqual({ site_hash: expectedHash, has_site_key: true, error: 'LICENSE_EXPIRED' });
    expectNoRawKey();
  });

  test('Site-based auth resolved: stored hash equal to the sent key is not logged', async () => {
    validateLicense.mockResolvedValue({ license: { id: 'acct-1', plan: 'pro' } });
    const next = jest.fn();
    await authMiddleware({ supabase: sitesSupabase({ status: 'active', license_key: KEY, site_hash: RAW_SITE_KEY }) })(
      makeReq('/api/alt-text', { 'X-Site-Key': RAW_SITE_KEY }), makeRes(), next
    );
    expect(next).toHaveBeenCalled();
    const info = line('[Auth] Site-based auth resolved');
    expect(info[1]).toEqual(expect.objectContaining({ site_hash: null, has_site_key: true }));
    expectNoRawKey();
  });

  test.each([
    ['X-Site-Key', { 'X-Trial-Mode': 'true', 'X-Site-Key': RAW_SITE_KEY }, null],
    ['X-Site-Hash', { 'X-Trial-Mode': 'true', 'X-Site-Hash': RAW_SITE_KEY }, null],
    ['X-Trial-Site-Hash also sent as X-Site-Key', { 'X-Trial-Mode': 'true', 'X-Trial-Site-Hash': RAW_SITE_KEY, 'X-Site-Key': RAW_SITE_KEY }, null]
  ])('trial accepted via %s logs has_site_key, not the value', async (_label, headers, expectedHash) => {
    const next = jest.fn();
    await authMiddleware({ supabase: {} })(makeReq('/api/alt-text', headers), makeRes(), next);
    expect(next).toHaveBeenCalled();
    const accepted = line('[Auth] Anonymous trial request accepted');
    expect(accepted[1]).toEqual(expect.objectContaining({ site_hash: expectedHash, has_site_key: true }));
    expectNoRawKey();
  });

  test('trial accepted via X-Trial-Site-Hash alone still logs the trial hash', async () => {
    await authMiddleware({ supabase: {} })(makeReq('/api/alt-text', { 'X-Trial-Mode': 'true', 'X-Trial-Site-Hash': 'trial-hash-1' }), makeRes(), jest.fn());
    const accepted = line('[Auth] Anonymous trial request accepted');
    expect(accepted[1]).toEqual(expect.objectContaining({ site_hash: 'trial-hash-1', has_site_key: false }));
  });

  test('storedSiteHashForLog', () => {
    expect(storedSiteHashForLog('abc', ['ABC '])).toBeNull();
    expect(storedSiteHashForLog('abc', ['xyz'])).toBe('abc');
    expect(storedSiteHashForLog(null, ['xyz'])).toBeNull();
    expect(storedSiteHashForLog('  ', [])).toBeNull();
  });
});
