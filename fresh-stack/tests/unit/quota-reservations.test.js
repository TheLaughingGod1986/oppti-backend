jest.mock('../../lib/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  getRecentEntries: jest.fn().mockReturnValue([]),
  clearRecentEntries: jest.fn()
}));

jest.mock('../../services/siteQuota', () => ({
  buildSiteIdentity: jest.requireActual('../../lib/siteIdentity').buildSiteIdentity,
  finalizeSiteGeneration: jest.fn().mockResolvedValue({ error: null }),
  getSiteQuotaStatus: jest.fn().mockResolvedValue({
    error: 'SITE_QUOTA_V2_UNAVAILABLE'
  }),
  reserveSiteCredits: jest.fn().mockResolvedValue({
    error: 'SITE_QUOTA_V2_UNAVAILABLE'
  })
}));

const logger = require('../../lib/logger');
const { reserveGenerationQuota } = require('../../services/quota');

describe('reserveGenerationQuota', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('falls back to legacy trial mode instead of 500 when v2 schema is absent', async () => {
    const result = await reserveGenerationQuota(null, {
      siteHash: 'trial-site',
      quotaMode: 'trial'
    });

    expect(result.error).toBeNull();
    expect(result.reservation).toEqual(expect.objectContaining({
      status: 'legacy_trial',
      quota_source: 'legacy_trial',
      plan: 'trial'
    }));
    expect(logger.warn).toHaveBeenCalledWith(
      '[V2_FALLBACK] Trial reservation V2 path failed; using legacy trial fallback',
      expect.objectContaining({
        v2_error_code: 'SITE_QUOTA_V2_UNAVAILABLE',
        site_hash: 'trial-site'
      })
    );
  });
});
