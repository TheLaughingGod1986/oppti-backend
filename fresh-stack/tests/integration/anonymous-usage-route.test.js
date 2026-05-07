const express = require('express');
const request = require('supertest');
const { authMiddleware } = require('../../middleware/auth');

jest.mock('../../services/quota', () => ({
  getQuotaStatus: jest.fn()
}));

const quotaService = require('../../services/quota');
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
    quotaService.getQuotaStatus.mockReset();
  });

  test('returns a trial contract for anonymous users even when site quota returns free-plan data', async () => {
    quotaService.getQuotaStatus.mockResolvedValue({
      error: null,
      plan_type: 'free',
      credits_used: 0,
      credits_remaining: 50,
      total_limit: 50,
      reset_date: '2026-04-30T00:00:00.000Z',
      warning_threshold: 0.9,
      is_near_limit: false,
      trial: {
        total_trial_credits: 5,
        used_trial_credits: 2
      }
    });

    const supabase = createAnonymousSupabaseMock(0);
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
    expect(res.body.data.auth_state).toBe('guest_trial');
    expect(res.body.data.quota_type).toBe('trial');
    expect(res.body.data.quota_state).toBe('active');
    expect(res.body.data.credits_total).toBe(5);
    expect(res.body.data.credits_used).toBe(2);
    expect(res.body.data.credits_remaining).toBe(3);
    expect(res.body.data.total_limit).toBe(5);
    expect(res.body.data.free_plan_offer).toBe(50);
    expect(res.body.data.signup_required).toBe(false);
    expect(res.body.data.anonymous).toEqual(expect.objectContaining({
      anon_id: 'anon-usage-1',
      used: 2,
      remaining: 3,
      total: 5
    }));
  });

  test('returns an exhausted anonymous trial contract at the limit', async () => {
    quotaService.getQuotaStatus.mockResolvedValue({
      error: 'SITE_QUOTA_V2_UNAVAILABLE'
    });

    const supabase = createAnonymousSupabaseMock(5);
    const app = express();
    app.use(express.json());
    app.use(authMiddleware({ supabase }));
    app.use('/api/usage', createUsageRouter({ supabase }));

    const res = await request(app)
      .get('/api/usage')
      .set('X-Site-Key', 'site-usage-anon')
      .set('X-Site-URL', 'https://example.com')
      .set('X-Anon-Id', 'anon-usage-2');

    expect(res.status).toBe(200);
    expect(res.body.data.auth_state).toBe('guest_trial');
    expect(res.body.data.quota_type).toBe('trial');
    expect(res.body.data.quota_state).toBe('exhausted');
    expect(res.body.data.credits_total).toBe(5);
    expect(res.body.data.credits_used).toBe(5);
    expect(res.body.data.credits_remaining).toBe(0);
    expect(res.body.data.signup_required).toBe(true);
    expect(res.body.data.upgrade_required).toBe(false);
    expect(res.body.data.free_plan_offer).toBe(50);
  });

  test('POST /api/usage/trial-batch-plan returns authoritative processable and skip counts', async () => {
    quotaService.getQuotaStatus.mockResolvedValue({
      error: null,
      plan_type: 'free',
      credits_used: 0,
      credits_remaining: 50,
      total_limit: 50,
      reset_date: '2026-04-30T00:00:00.000Z',
      warning_threshold: 0.9,
      is_near_limit: false,
      trial: {
        total_trial_credits: 5,
        used_trial_credits: 2
      }
    });

    const supabase = createAnonymousSupabaseMock(0);
    const app = express();
    app.use(express.json());
    app.use(authMiddleware({ supabase }));
    app.use('/api/usage', createUsageRouter({ supabase }));

    const res = await request(app)
      .post('/api/usage/trial-batch-plan')
      .set('X-Trial-Mode', 'true')
      .set('X-Trial-Site-Hash', 'site-usage-anon')
      .set('X-Site-URL', 'https://example.com')
      .send({ requested_count: 6 });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.trial_generation.requested_count).toBe(6);
    expect(res.body.trial_generation.processable_count).toBe(3);
    expect(res.body.trial_generation.skipped_due_to_limit).toBe(3);
    expect(res.body.trial_generation.trial_limit).toBe(5);
    expect(res.body.trial_generation.trial_used_before).toBe(2);
  });

  test('keeps authenticated free-account quota separate from anonymous trial quota', async () => {
    quotaService.getQuotaStatus.mockResolvedValue({
      error: null,
      plan_type: 'free',
      credits_used: 7,
      credits_remaining: 43,
      total_limit: 50,
      reset_date: '2026-04-30T00:00:00.000Z',
      warning_threshold: 0.9,
      is_near_limit: false
    });

    const app = express();
    app.use(express.json());
    app.use('/api/usage', createUsageRouter({ supabase: createAnonymousSupabaseMock(0) }));

    const res = await request(app)
      .get('/api/usage')
      .set('X-License-Key', 'license-free-1');

    expect(res.status).toBe(200);
    expect(res.body.data.auth_state).toBe('authenticated');
    expect(res.body.data.quota_type).toBe('monthly');
    expect(res.body.data.credits_total).toBe(50);
    expect(res.body.data.credits_used).toBe(7);
    expect(res.body.data.credits_remaining).toBe(43);
    expect(res.body.data.plan_type).toBe('free');
    expect(res.body.data.signup_required).toBe(false);
  });
});
