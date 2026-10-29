const logger = require('../../lib/logger');
jest.mock('../../services/license', () => ({ validateLicense: jest.fn() }));
const { validateLicense } = require('../../services/license');
const { authMiddleware } = require('../../middleware/auth');

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

  // A stored site_hash replays as X-Site-Key, so neither the sent key nor the
  // stored value is logged: only has_site_key and the header that carried it.
  test.each([
    ['stored site_hash equals the sent key', RAW_SITE_KEY],
    ['site row has no site_hash', null],
    ['stored site_hash differs from the sent key', 'stored-hash-abc']
  ])('Site-key resolved license invalid (%s)', async (_label, storedHash) => {
    validateLicense.mockResolvedValue({ error: 'LICENSE_EXPIRED' });
    await authMiddleware({ supabase: sitesSupabase({ status: 'active', license_key: KEY, site_hash: storedHash }) })(
      makeReq('/api/alt-text', { 'X-Site-Key': RAW_SITE_KEY }), makeRes(), jest.fn()
    );
    const warn = line('[Auth] Site-key resolved license invalid');
    expect(warn[1]).toEqual({ has_site_key: true, matched_by: 'X-Site-Key', error: 'LICENSE_EXPIRED' });
    expectNoRawKey();
    if (storedHash) expect(JSON.stringify(allCalls())).not.toContain(storedHash);
  });

  test('Site-based auth resolved: neither the sent key nor the stored hash is logged', async () => {
    validateLicense.mockResolvedValue({ license: { id: 'acct-1', plan: 'pro' } });
    const next = jest.fn();
    await authMiddleware({ supabase: sitesSupabase({ status: 'active', license_key: KEY, site_hash: 'stored-hash-abc' }) })(
      makeReq('/api/alt-text', { 'X-Site-Key': RAW_SITE_KEY }), makeRes(), next
    );
    expect(next).toHaveBeenCalled();
    const info = line('[Auth] Site-based auth resolved');
    expect(info[1]).toEqual(expect.objectContaining({ has_site_key: true, matched_by: 'X-Site-Key' }));
    expect(info[1]).not.toHaveProperty('site_hash');
    expectNoRawKey();
    expect(JSON.stringify(allCalls())).not.toContain('stored-hash-abc');
  });

  test.each([
    ['X-Site-Key', { 'X-Trial-Mode': 'true', 'X-Site-Key': RAW_SITE_KEY }, 'X-Site-Key'],
    ['X-Site-Hash', { 'X-Trial-Mode': 'true', 'X-Site-Hash': RAW_SITE_KEY }, 'X-Site-Hash'],
    ['X-Trial-Site-Hash', { 'X-Trial-Mode': 'true', 'X-Trial-Site-Hash': RAW_SITE_KEY }, 'X-Trial-Site-Hash'],
    ['X-Trial-Site-Hash also sent as X-Site-Key', { 'X-Trial-Mode': 'true', 'X-Trial-Site-Hash': RAW_SITE_KEY, 'X-Site-Key': RAW_SITE_KEY }, 'X-Site-Key']
  ])('trial accepted via %s logs has_site_key and the header, not the value', async (_label, headers, matchedBy) => {
    const next = jest.fn();
    await authMiddleware({ supabase: {} })(makeReq('/api/alt-text', headers), makeRes(), next);
    expect(next).toHaveBeenCalled();
    const accepted = line('[Auth] Anonymous trial request accepted');
    expect(accepted[1]).toEqual(expect.objectContaining({ has_site_key: true, matched_by: matchedBy }));
    expect(accepted[1]).not.toHaveProperty('site_hash');
    expectNoRawKey();
  });

  test('body installId is a raw site key for logging purposes', () => {
    const { rawSiteKeysFromRequest } = require('../../lib/logPath');
    expect(rawSiteKeysFromRequest({ body: { installId: 'inst-1' }, header: () => null })).toEqual(['inst-1']);
  });
});
