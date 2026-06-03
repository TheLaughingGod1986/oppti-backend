const { getDailyQuotaWindow, withDailyFreeAllowance } = require('../../services/quota');

describe('daily free generation allowance', () => {
  test('keeps a fixed UTC day boundary helper for migrations and diagnostics', () => {
    expect(getDailyQuotaWindow(new Date('2026-05-26T12:30:00.000Z'))).toEqual({
      start: '2026-05-26T00:00:00.000Z',
      end: '2026-05-27T00:00:00.000Z'
    });
  });

  test('does not mutate logged-in quota responses with a daily cap', async () => {
    const supabase = {
      from: jest.fn()
    };
    const status = {
      plan_type: 'free',
      credits_remaining: 45,
      total_limit: 50,
      quota_state: 'active'
    };

    await expect(withDailyFreeAllowance(supabase, status, {
      siteHash: 'site-free',
      licenseKey: 'license-free'
    })).resolves.toBe(status);
    expect(supabase.from).not.toHaveBeenCalled();
  });
});
