const logger = require('../../lib/logger');
const { recordUsage } = require('../../services/usage');

const KEY = 'QA-FAKE-LICENSE-KEY-0001';
const EMAIL = 'qa-person@example.invalid';
const SITE_URL = 'https://qa-site.invalid';

function supabaseMock() {
  return {
    from(table) {
      if (table === 'licenses') {
        return { select: () => ({ eq: () => ({ maybeSingle: () => Promise.reject(new Error('lookup down')) }) }) };
      }
      return { insert: () => ({ select: () => Promise.resolve({ data: null, error: { message: 'insert failed', code: '23505' } }) }) };
    }
  };
}

describe('usage log lines carry no part of the licence key', () => {
  let spies;
  beforeEach(() => {
    spies = ['warn', 'info', 'debug', 'error'].map((level) => jest.spyOn(logger, level).mockImplementation(() => {}));
  });
  afterEach(() => spies.forEach((spy) => spy.mockRestore()));
  const allCalls = () => spies.flatMap((spy) => spy.mock.calls);
  const line = (message) => allCalls().find(([m]) => m === message);

  test('lookup-failed, inserting and insert-failed lines log has_license_key only', async () => {
    await recordUsage(supabaseMock(), {
      licenseKey: KEY,
      siteHash: 'site-hash-1',
      siteUrl: SITE_URL,
      domain: 'qa-site.invalid',
      userEmail: EMAIL,
      imageUrl: `${SITE_URL}/wp-content/uploads/photo.jpg`,
      creditsUsed: 1
    });
    const lookup = line('[usage] license_id_lookup_failed');
    expect(lookup[1]).toEqual(expect.objectContaining({ has_license_key: true }));
    expect(lookup[1]).not.toHaveProperty('license_key');
    const inserting = line('[usage] Inserting usage log');
    expect(inserting[1]).toEqual(expect.objectContaining({ has_license_key: true }));
    expect(inserting[1]).not.toHaveProperty('license_key');
    const failed = line('[usage] Failed to insert usage log');
    expect(failed[1].payload).toEqual(expect.objectContaining({
      has_license_key: true, has_user_email: true, has_site_url: true, has_image_url: true
    }));
    for (const key of ['license_key', 'user_email', 'site_url', 'domain', 'image_url']) {
      expect(failed[1].payload).not.toHaveProperty(key);
    }
    const logged = JSON.stringify(allCalls());
    expect(logged).not.toContain(KEY.substring(0, 8));
    expect(logged).not.toContain(KEY.slice(-8));
    expect(logged).not.toMatch(/example\.invalid|qa-site\.invalid/);
  });
});
