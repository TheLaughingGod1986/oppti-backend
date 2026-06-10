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
const siteQuota = require('../../services/siteQuota');
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

  test('falls back to monthly legacy quota when disabled daily cap is still returned by v2 RPC', async () => {
    siteQuota.reserveSiteCredits.mockResolvedValueOnce({
      error: 'DAILY_QUOTA_EXCEEDED',
      status: 402,
      message: 'Daily free generation limit reached'
    });

    const supabase = {
      from(table) {
        if (table === 'sites') {
          return {
            select() {
              return {
                eq() {
                  return {
                    eq() {
                      return {
                        maybeSingle: jest.fn().mockResolvedValue({
                          data: { license_key: 'license-free' },
                          error: null
                        })
                      };
                    }
                  };
                }
              };
            }
          };
        }

        if (table === 'licenses') {
          return {
            select() {
              return {
                eq() {
                  return {
                    single: jest.fn().mockResolvedValue({
                      data: {
                        id: 'license_free',
                        license_key: 'license-free',
                        plan: 'free',
                        billing_day_of_month: 1
                      },
                      error: null
                    })
                  };
                }
              };
            }
          };
        }

        if (table === 'quota_summaries') {
          return {
            select() {
              return {
                eq() {
                  return {
                    eq() {
                      return {
                        maybeSingle: jest.fn().mockResolvedValue({
                          data: null,
                          error: null
                        })
                      };
                    }
                  };
                }
              };
            }
          };
        }

        if (table === 'usage_logs') {
          const query = {
            select() { return query; },
            gte() { return query; },
            lt() { return query; },
            eq() { return query; },
            then(resolve, reject) {
              return Promise.resolve({
                data: [{ credits_used: 1, site_hash: 'site-free', license_key: 'license-free' }],
                error: null
              }).then(resolve, reject);
            }
          };
          return query;
        }

        throw new Error(`Unexpected table: ${table}`);
      }
    };

    const result = await reserveGenerationQuota(supabase, {
      licenseKey: 'license-free',
      siteHash: 'site-free',
      quotaMode: 'site'
    });

    expect(result.error).toBeNull();
    expect(result.reservation).toEqual(expect.objectContaining({
      status: 'legacy_reserved',
      quota_source: 'legacy',
      plan: 'free',
      remaining_credits: 49
    }));
  });
});
