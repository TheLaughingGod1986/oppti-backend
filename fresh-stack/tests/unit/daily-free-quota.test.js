const { getDailyQuotaWindow, withDailyFreeAllowance } = require('../../services/quota');

function createUsageSupabase(rows) {
  const filters = [];
  const query = {
    select() { return query; },
    eq(column, value) {
      filters.push([column, value]);
      return query;
    },
    gte() { return query; },
    lt() { return query; },
    then(resolve, reject) {
      return Promise.resolve({ data: rows, error: null }).then(resolve, reject);
    }
  };
  return {
    filters,
    from: jest.fn(() => query)
  };
}

describe('daily free generation allowance', () => {
  test('uses a fixed UTC day boundary', () => {
    expect(getDailyQuotaWindow(new Date('2026-05-26T12:30:00.000Z'))).toEqual({
      start: '2026-05-26T00:00:00.000Z',
      end: '2026-05-27T00:00:00.000Z'
    });
  });

  test('counts successful free generation credits for the current site', async () => {
    const supabase = createUsageSupabase([{ credits_used: 1 }, { credits_used: 1 }, { credits_used: 1 }, { credits_used: 1 }, { credits_used: 1 }]);
    const status = await withDailyFreeAllowance(supabase, {
      plan_type: 'free',
      credits_remaining: 45,
      site: { site_hash: 'site-free' }
    });

    expect(status).toEqual(expect.objectContaining({
      daily_generation_limit: 5,
      daily_generations_used: 5,
      daily_generations_remaining: 0,
      quota_state: 'daily_exhausted'
    }));
    expect(supabase.filters).toContainEqual(['status', 'success']);
    expect(supabase.filters).toContainEqual(['site_hash', 'site-free']);
  });

  test('keeps monthly exhaustion as the blocking explanation', async () => {
    const status = await withDailyFreeAllowance(createUsageSupabase([{ credits_used: 1 }]), {
      plan_type: 'free',
      credits_remaining: 0,
      site_quota: { site_hash: 'site-free' }
    });

    expect(status.quota_state).toBe('exhausted');
  });

  test('does not add a daily cap to paid plans', async () => {
    const supabase = createUsageSupabase([{ credits_used: 100 }]);
    const status = await withDailyFreeAllowance(supabase, {
      plan_type: 'pro',
      credits_remaining: 900
    });

    expect(status.daily_generation_limit).toBeUndefined();
    expect(supabase.from).not.toHaveBeenCalled();
  });

  test('does not add a daily cap to repaired paid quota rows with a stale free label', async () => {
    const supabase = createUsageSupabase([{ credits_used: 39 }]);
    const status = await withDailyFreeAllowance(supabase, {
      plan_type: 'free',
      credits_remaining: 951,
      total_limit: 1000
    });

    expect(status.daily_generation_limit).toBeUndefined();
    expect(status.quota_state).toBeUndefined();
    expect(supabase.from).not.toHaveBeenCalled();
  });
});
