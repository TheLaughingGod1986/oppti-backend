/**
 * /api/titles/generate end-to-end pipeline with mocked OpenAI + quota.
 */
const express = require('express');
const request = require('supertest');

jest.mock('../../middleware/auth', () => {
  const passthrough = (req, _res, next) => {
    req.license = {
      id: '11111111-1111-1111-1111-111111111111',
      license_key: 'test-titles-license',
      plan: 'pro',
      status: 'active'
    };
    req.authMethod = 'license';
    next();
  };
  return {
    authMiddleware: () => passthrough,
    extractUserInfo: () => ({ user_id: null, user_email: null, plugin_version: '1.0.0' })
  };
});

jest.mock('../../lib/openaiTitles', () => ({
  generateTitleAndMeta: jest.fn(async ({ page, previous }) => {
    if (page?.url === '/fail') {
      const e = new Error('upstream rate limited');
      e.code = 'UPSTREAM_RATE_LIMITED';
      e.httpStatus = 429;
      e.isRetryable = true;
      throw e;
    }
    return {
      title: previous ? 'Regenerated title' : `Title for ${page?.url || 'page'}`,
      meta: previous ? 'Regenerated meta description.' : `Meta description for ${page?.url || 'page'}.`,
      usage: { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130 },
      meta_info: { modelUsed: 'gpt-4o-mini', regenerated: Boolean(previous), latencyMs: 5 }
    };
  }),
  buildTitlesPrompt: jest.fn()
}));

jest.mock('../../services/titleQuota', () => {
  let remaining = 5;
  return {
    TITLES_FEATURE_TYPE: 'title_meta',
    reserveTitleGenerationQuota: jest.fn(async () => {
      if (remaining <= 0) {
        return {
          error: 'QUOTA_EXCEEDED',
          status: 402,
          message: 'Quota exceeded',
          payload: { remaining_credits: 0, total_limit: 5, credits_used: 5 }
        };
      }
      remaining -= 1;
      return {
        error: null,
        site: { id: 'site-1', site_hash: 'site-hash', license_key: 'test-titles-license' },
        reservation: {
          generation_request_id: 'gen-1',
          remaining_credits: remaining,
          total_limit: 5,
          credits_used: 5 - remaining,
          daily_remaining: remaining,
          daily_limit: 5,
          plan: 'free',
          quota_period_end: '2026-07-01T00:00:00.000Z'
        }
      };
    }),
    finalizeTitleGenerationQuota: jest.fn(async () => ({ data: { status: 'succeeded' }, error: null })),
    getTitleQuotaStatus: jest.fn(async () => ({
      feature_type: 'title_meta',
      credits_remaining: remaining,
      total_limit: 5,
      credits_used: 5 - remaining,
      daily_limit: 5,
      daily_remaining: remaining,
      source: 'site_title_quotas'
    })),
    buildTitleRequestFingerprint: jest.fn(() => 'fp-deterministic'),
    __setRemaining: (n) => { remaining = n; }
  };
});

jest.mock('../../services/usage', () => ({
  recordUsage: jest.fn().mockResolvedValue({ error: null })
}));

const { createTitlesRouter } = require('../../routes/titles');
const titleQuota = require('../../services/titleQuota');

function buildApp() {
  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use((req, res, next) => {
    req.id = 'req-test';
    next();
  });
  app.use(
    '/api/titles',
    createTitlesRouter({
      supabase: {},
      checkRateLimit: async () => true,
      createJob: jest.fn(async () => 'job-uuid'),
      getJobRecord: jest.fn(async () => null)
    })
  );
  return app;
}

describe('POST /api/titles/generate', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    titleQuota.__setRemaining(5);
  });

  test('returns title + meta + entitlement on success', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/titles/generate')
      .set('X-License-Key', 'test-titles-license')
      .set('X-Site-Hash', 'site-hash')
      .set('X-Site-URL', 'https://example.test')
      .send({
        page: { url: '/about', h1: 'About', content_excerpt: 'We make coffee.' },
        options: { brand_name: 'Mission Coffee', tone: 'professional' }
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.title).toBe('Title for /about');
    expect(res.body.meta).toContain('Meta description');
    expect(res.body.credits_remaining).toBe(4);
    expect(res.body.entitlement_state.feature_type).toBe('title_meta');
    expect(res.body.usage.total_tokens).toBe(130);
  });

  test('returns regenerated flag and different content when previous is supplied', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/titles/generate')
      .set('X-License-Key', 'test-titles-license')
      .set('X-Site-Hash', 'site-hash')
      .set('X-Site-URL', 'https://example.test')
      .send({
        page: { url: '/about', h1: 'About' },
        previous: { title: 'Old', meta: 'Old meta' }
      });
    expect(res.status).toBe(200);
    expect(res.body.title).toBe('Regenerated title');
    expect(res.body.meta_info.regenerated).toBe(true);
  });

  test('returns 402 with entitlement_state when quota is exceeded', async () => {
    titleQuota.__setRemaining(0);
    const app = buildApp();
    const res = await request(app)
      .post('/api/titles/generate')
      .set('X-License-Key', 'test-titles-license')
      .set('X-Site-Hash', 'site-hash')
      .set('X-Site-URL', 'https://example.test')
      .send({ page: { url: '/about', h1: 'About' } });
    expect(res.status).toBe(402);
    expect(res.body.code).toBe('QUOTA_EXCEEDED');
    expect(res.body.entitlement_state).toBeTruthy();
    expect(res.body.entitlement_state.credits_remaining).toBe(0);
  });

  test('returns 400 for invalid request bodies', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/titles/generate')
      .set('X-License-Key', 'test-titles-license')
      .set('X-Site-Hash', 'site-hash')
      .set('X-Site-URL', 'https://example.test')
      .send({ /* missing page */ });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_REQUEST');
  });

  test('returns 429 and releases reservation when OpenAI rate-limits', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/titles/generate')
      .set('X-License-Key', 'test-titles-license')
      .set('X-Site-Hash', 'site-hash')
      .set('X-Site-URL', 'https://example.test')
      .send({ page: { url: '/fail', h1: 'Fail' } });
    expect(res.status).toBe(429);
    expect(res.body.code).toBe('UPSTREAM_RATE_LIMITED');
    expect(titleQuota.finalizeTitleGenerationQuota).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ success: false })
    );
  });
});
