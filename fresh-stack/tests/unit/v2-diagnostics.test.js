const { inspectV2Schema } = require('../../services/v2Diagnostics');

describe('inspectV2Schema', () => {
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
    expect(report.missing_optional_functions).toEqual(['bbai_merge_sites']);
    expect(report.optional_functions.bbai_merge_sites.available).toBe(false);
  });
});
