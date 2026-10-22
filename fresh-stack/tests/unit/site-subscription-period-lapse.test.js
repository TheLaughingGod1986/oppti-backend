const { selectActiveSiteSubscription, isSubscriptionPeriodLapsed } = require('../../services/siteQuota');

const DAY = 24 * 60 * 60 * 1000;
const iso = (offsetDays) => new Date(Date.now() + offsetDays * DAY).toISOString();

// Mimics the PostgREST chain: filter by site/status, order by current_period_end desc nulls last, limit.
function stubSupabase(rows) {
  return {
    from() {
      const state = { rows: rows.slice(), limit: null };
      const chain = {
        select: () => chain,
        eq: (column, value) => { state.rows = state.rows.filter((row) => row[column] === value); return chain; },
        in: (column, values) => { state.rows = state.rows.filter((row) => values.includes(row[column])); return chain; },
        order: () => {
          state.rows.sort((a, b) => {
            if (a.current_period_end == null && b.current_period_end == null) return 0;
            if (a.current_period_end == null) return 1;
            if (b.current_period_end == null) return -1;
            return Date.parse(b.current_period_end) - Date.parse(a.current_period_end);
          });
          return chain;
        },
        limit: async (count) => ({ data: state.rows.slice(0, count), error: null })
      };
      return chain;
    }
  };
}

const row = (id, periodEnd, extra = {}) => ({
  id, site_id: 'site_1', plan_id: 'pro', status: 'active', current_period_end: periodEnd, ...extra
});

describe('selectActiveSiteSubscription honours current_period_end', () => {
  test('a current row is returned', async () => {
    const result = await selectActiveSiteSubscription(stubSupabase([row('current', iso(20))]), 'site_1');
    expect(result?.id).toBe('current');
  });

  test('an active row whose period ended more than 3 days ago grants nothing', async () => {
    const result = await selectActiveSiteSubscription(stubSupabase([row('stale', iso(-30))]), 'site_1');
    expect(result).toBeNull();
  });

  test('a row that ended within the 3-day grace still counts', async () => {
    const result = await selectActiveSiteSubscription(stubSupabase([row('grace', iso(-2))]), 'site_1');
    expect(result?.id).toBe('grace');
  });

  test('null current_period_end keeps today\'s behaviour and wins over lapsed rows', async () => {
    const result = await selectActiveSiteSubscription(stubSupabase([
      row('stale_a', iso(-60)),
      row('stale_b', iso(-30)),
      row('no_period', null, { stripe_subscription_id: 'sub_1' })
    ]), 'site_1');
    expect(result?.id).toBe('no_period');
  });

  test('canceled rows are still ignored', async () => {
    const result = await selectActiveSiteSubscription(stubSupabase([
      row('canceled', iso(20), { status: 'canceled' })
    ]), 'site_1');
    expect(result).toBeNull();
  });

  test('isSubscriptionPeriodLapsed edge cases', () => {
    const now = Date.parse('2026-10-22T12:00:00Z');
    expect(isSubscriptionPeriodLapsed({ current_period_end: null }, now)).toBe(false);
    expect(isSubscriptionPeriodLapsed({ current_period_end: 'not-a-date' }, now)).toBe(false);
    expect(isSubscriptionPeriodLapsed({ current_period_end: '2026-10-19T12:00:01Z' }, now)).toBe(false);
    expect(isSubscriptionPeriodLapsed({ current_period_end: '2026-10-19T11:59:59Z' }, now)).toBe(true);
  });
});
