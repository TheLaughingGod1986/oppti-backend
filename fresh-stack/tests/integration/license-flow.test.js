/**
 * Lightweight integration-style test using mocked Supabase client.
 */

jest.mock('../../services/siteQuota', () => ({
  ensureSiteMembership: jest.fn().mockResolvedValue({
    id: 'membership-1',
    site_id: 'site-1',
    user_id: 'lic-1',
    role: 'owner'
  }),
  recordSiteAudit: jest.fn().mockResolvedValue(undefined),
  resolveCanonicalSite: jest.fn().mockResolvedValue({
    site: {
      id: 'site-1',
      site_hash: 'site-1',
      site_url: 'https://example.com',
      license_key: 'key-123'
    },
    matchedBy: 'created',
    created: true,
    error: null
  }),
  syncLegacySitePointers: jest.fn().mockResolvedValue(undefined)
}));

const { activateLicense } = require('../../services/license');

function createSupabaseMock() {
  return {
    from: (table) => {
      if (table === 'licenses') {
        return {
          select: () => ({
            eq: () => ({
              single: () =>
                Promise.resolve({
                  data: { id: 'lic-1', license_key: 'key-123', plan: 'pro', status: 'active', billing_day_of_month: 1 },
                  error: null
                }),
              maybeSingle: () =>
                Promise.resolve({
                  data: { id: 'lic-1', license_key: 'key-123', plan: 'pro', status: 'active', billing_day_of_month: 1 },
                  error: null
                })
            })
          })
        };
      }
      return {};
    }
  };
}

describe('license activation flow', () => {
  test('activates a new site', async () => {
    const supabase = createSupabaseMock();
    const result = await activateLicense(supabase, {
      licenseKey: 'key-123',
      siteHash: 'site-1',
      siteUrl: 'https://example.com'
    });
    expect(result.error).toBeUndefined();
    expect(result.site.site_hash).toBe('site-1');
  });
});
