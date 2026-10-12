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

function parseFilterValue(raw) {
  if (raw === 'null') return null;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw !== '' && !Number.isNaN(Number(raw))) return Number(raw);
  return raw;
}

// Minimal PostgREST `.or()` support: "col.op.value,col.op.value" (eq, neq, is, gt, gte, lt, lte).
function matchesOrFilter(row, expression) {
  return String(expression || '').split(',').some((clause) => {
    const [column, op, ...rest] = clause.trim().split('.');
    const expected = parseFilterValue(rest.join('.'));
    const actual = row?.[column] === undefined ? null : row[column];
    switch (op) {
      case 'is': return actual === expected;
      case 'eq': return actual !== null && actual === expected;
      case 'neq': return actual !== null && actual !== expected;
      case 'gt': return actual !== null && actual > expected;
      case 'gte': return actual !== null && actual >= expected;
      case 'lt': return actual !== null && actual < expected;
      case 'lte': return actual !== null && actual <= expected;
      default: throw new Error(`Unsupported or() operator: ${op}`);
    }
  });
}

function createUsageLogsQuery(usageRows) {
  let rows = usageRows.slice();
  const query = {
    select() { return query; },
    gte() { return query; },
    lt() { return query; },
    eq(column, value) {
      rows = rows.filter((row) => row?.[column] === value);
      return query;
    },
    or(expression) {
      rows = rows.filter((row) => matchesOrFilter(row, expression));
      return query;
    },
    then(resolve, reject) {
      return Promise.resolve({ data: rows, error: null }).then(resolve, reject);
    }
  };
  return query;
}

function createLegacyFallbackSupabase(usageRows) {
  return {
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
        return createUsageLogsQuery(usageRows);
      }

      throw new Error(`Unexpected table: ${table}`);
    }
  };
}

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

    const supabase = createLegacyFallbackSupabase([
      { credits_used: 1, site_hash: 'site-free', license_key: 'license-free' }
    ]);

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
      remaining_credits: 24
    }));
  });
  test('legacy usage_logs fallback excludes guest-trial rows from the free allowance', async () => {
    siteQuota.reserveSiteCredits.mockResolvedValueOnce({
      error: 'DAILY_QUOTA_EXCEEDED',
      status: 402,
      message: 'Daily free generation limit reached'
    });

    const base = { site_hash: 'site-free', credits_used: 1 };
    const supabase = createLegacyFallbackSupabase([
      // 10 guest-trial rows (no license yet)
      ...Array.from({ length: 10 }, () => ({ ...base, license_key: null, is_trial: true })),
      // 13 signed-in rows + 1 legacy row with is_trial null (must still count)
      ...Array.from({ length: 13 }, () => ({ ...base, license_key: 'license-free', is_trial: false })),
      { ...base, license_key: 'license-free', is_trial: null }
    ]);

    const result = await reserveGenerationQuota(supabase, {
      licenseKey: 'license-free',
      siteHash: 'site-free',
      quotaMode: 'site'
    });

    expect(result.error).toBeNull();
    // 25 free - 14 signed-in used = 11 (trial rows would make it 1)
    expect(result.reservation).toEqual(expect.objectContaining({
      status: 'legacy_reserved',
      quota_source: 'legacy',
      plan: 'free',
      remaining_credits: 11
    }));
  });
});
