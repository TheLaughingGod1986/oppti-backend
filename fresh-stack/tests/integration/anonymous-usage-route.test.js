const express = require('express');
const request = require('supertest');
const { authMiddleware } = require('../../middleware/auth');

jest.mock('../../services/quota', () => ({
  getQuotaStatus: jest.fn().mockResolvedValue({
    error: 'SITE_QUOTA_V2_UNAVAILABLE'
  })
}));

const { createUsageRouter } = require('../../routes/usage');

function createAnonymousSupabaseMock(trialUsageCount = 0) {
  const trialUsage = Array.from({ length: trialUsageCount }, (_, index) => ({
    id: `trial_${index + 1}`,
    site_hash: 'site-usage-anon'
  }));

  function buildChain(rows, { countMode = false } = {}) {
    const filters = [];
    const chain = {
      select(_columns, options = {}) {
        return buildChain(rows, { countMode: Boolean(options?.head && options?.count === 'exact') });
      },
      eq(column, value) {
        filters.push({ column, value });
        return chain;
      },
      then(resolve, reject) {
        const results = rows.filter((row) => filters.every(({ column, value }) => row[column] === value));
        const payload = countMode
          ? { count: results.length, error: null }
          : { data: results, error: null };
        return Promise.resolve(payload).then(resolve, reject);
      }
    };
    return chain;
  }

  return {
    from(table) {
      if (table === 'trial_usage') {
        return buildChain(trialUsage);
      }

      return buildChain([]);
    }
  };
}

describe('GET /usage anonymous trial status', () => {
  beforeEach(() => {
    process.env.ANONYMOUS_TRIAL_CREDITS = '5';
  });

  test('returns remaining anonymous credits for a logged-out dashboard user', async () => {
    const supabase = createAnonymousSupabaseMock(2);
    const app = express();
    app.use(express.json());
    app.use(authMiddleware({ supabase }));
    app.use('/api/usage', createUsageRouter({ supabase }));

    const res = await request(app)
      .get('/api/usage')
      .set('X-Site-Key', 'site-usage-anon')
      .set('X-Site-URL', 'https://example.com')
      .set('X-Anon-Id', 'anon-usage-1');

    expect(res.status).toBe(200);
    expect(res.body.data.credits_used).toBe(2);
    expect(res.body.data.credits_remaining).toBe(3);
    expect(res.body.data.total_limit).toBe(5);
    expect(res.body.data.signup_required).toBe(false);
    expect(res.body.data.anonymous).toEqual(expect.objectContaining({
      anon_id: 'anon-usage-1',
      used: 2,
      remaining: 3,
      total: 5
    }));
  });
});
