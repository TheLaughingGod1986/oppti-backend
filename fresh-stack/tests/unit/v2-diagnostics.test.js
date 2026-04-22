jest.mock('../../lib/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn()
}));

const logger = require('../../lib/logger');
const { inspectV2Schema, logV2SchemaStartupStatus } = require('../../services/v2Diagnostics');

describe('inspectV2Schema', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('keeps V2 available when only the optional merge admin RPC is missing', async () => {
    const missingSchemaError = {
      code: 'PGRST202',
      message: 'Could not find the function in the schema cache'
    };

    const supabase = {
      rpc: jest.fn(async (name) => {
        if (name === 'bbai_merge_sites') {
          return { data: null, error: missingSchemaError };
        }

        return {
          data: { ok: false, code: 'SITE_REQUIRED' },
          error: { code: '22023', message: 'diagnostic validation error' }
        };
      }),
      from: jest.fn(() => ({
        select: () => ({
          limit: async () => ({ error: null })
        })
      }))
    };

    const report = await inspectV2Schema(supabase);

    expect(report.available).toBe(true);
    expect(report.fallback_mode).toBe(false);
    expect(report.missing_functions).toEqual([]);
    expect(report.missing_deprecated_functions).toEqual(['bbai_merge_sites']);
    expect(report.deprecated_functions.bbai_merge_sites).toEqual(expect.objectContaining({
      available: false,
      classification: 'DEPRECATED_RPC',
      note: 'present for backward compatibility; no runtime callers',
      required_for_v2_health: false
    }));
  });

  it('does not emit V2_SCHEMA_CRITICAL when only bbai_merge_sites is missing', async () => {
    const report = {
      available: true,
      checked_at: '2026-04-22T12:00:00.000Z',
      missing_functions: [],
      missing_deprecated_functions: ['bbai_merge_sites'],
      missing_tables: []
    };

    const result = logV2SchemaStartupStatus(report);

    expect(result).toBe(report);
    expect(logger.info).toHaveBeenCalledWith('[V2_SCHEMA] V2 quota schema verified at startup', {
      checked_at: '2026-04-22T12:00:00.000Z'
    });
    expect(logger.error).not.toHaveBeenCalled();
  });
});
