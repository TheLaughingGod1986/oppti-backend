/**
 * /api/content-refresh/suggest end-to-end pipeline with mocked OpenAI + quota.
 */
const express = require('express');
const request = require('supertest');

jest.mock('../../middleware/auth', () => {
  const passthrough = (req, _res, next) => {
    req.license = {
      id: '11111111-1111-1111-1111-111111111111',
      license_key: 'test-refresh-license',
      plan: 'pro',
      status: 'active'
    };
    req.authMethod = 'license';
    next();
  };
  return {
    authMiddleware: () => passthrough,
    extractUserInfo: () => ({ user_id: null, user_email: null, plugin_version: '0.1.1' })
  };
});

jest.mock('../../lib/openaiContentRefresh', () => ({
  generateContentRefreshSuggestions: jest.fn(async ({ post }) => {
    if (post?.url === '/fail') {
      const e = new Error('upstream rate limited');
      e.code = 'UPSTREAM_RATE_LIMITED';
      e.httpStatus = 429;
      e.isRetryable = true;
      throw e;
    }
    return {
      suggestions: {
        title: 'Fresh Title',
        meta_description: 'Updated meta',
        intro_html: '<p>Intro</p>',
        sections: [{ heading: 'New section', html: '<p>Body</p>', action: 'add', target_heading: '' }],
        last_updated_note: 'Updated November 2026',
        rationale: 'Refresh outdated years'
      },
      usage: { prompt_tokens: 200, completion_tokens: 80, total_tokens: 280 },
      meta_info: { modelUsed: 'gpt-4o-mini', latencyMs: 5 }
    };
  })
}));

jest.mock('../../services/contentRefreshQuota', () => {
  let remaining = 5;
  return {
    CONTENT_REFRESH_FEATURE_TYPE: 'content_refresh',
    reserveContentRefreshQuota: jest.fn(async () => {
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
        site: { id: 'site-1', site_hash: 'site-hash', license_key: 'test-refresh-license' },
        reservation: {
          generation_request_id: 'gen-cr-1',
          remaining_credits: remaining,
          total_limit: 5,
          credits_used: 5 - remaining,
          plan: 'free',
          quota_period_end: '2026-07-01T00:00:00.000Z'
        }
      };
    }),
    finalizeContentRefreshQuota: jest.fn(async () => ({ data: { status: 'succeeded' }, error: null })),
    getContentRefreshQuotaStatus: jest.fn(async () => ({
      feature_type: 'content_refresh',
      credits_remaining: remaining,
      total_limit: 5,
      credits_used: 5 - remaining,
      source: 'site_quotas_shared'
    })),
    buildContentRefreshRequestFingerprint: jest.fn(() => 'fp-cr-deterministic'),
    __setRemaining: (n) => { remaining = n; }
  };
});

jest.mock('../../services/usage', () => ({
  recordUsage: jest.fn().mockResolvedValue({ error: null })
}));

jest.mock('../../services/contentRefreshConnection', () => ({
  recordContentRefreshConnection: jest.fn().mockResolvedValue({ recorded: true, isFirstConnection: false })
}));

const { createContentRefreshRouter } = require('../../routes/contentRefresh');
const refreshQuota = require('../../services/contentRefreshQuota');
const { recordUsage } = require('../../services/usage');

function buildApp() {
  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use((req, res, next) => {
    req.id = 'req-test';
    next();
  });
  app.use(
    '/api/content-refresh',
    createContentRefreshRouter({
      supabase: {},
      checkRateLimit: async () => true
    })
  );
  return app;
}

const validBody = {
  post: {
    id: 17,
    url: 'https://example.test/old-guide',
    title: 'Old Guide',
    content_excerpt: 'Tips from 2018.',
    meta_description: 'Old meta',
    word_count: 120,
    headings: [{ level: 2, text: 'Intro' }],
    decay_score: 65,
    decay_reasons: ['age', 'outdated_years'],
    outdated_years: [2018]
  },
  options: {
    include_intro: true,
    include_sections: true,
    include_title_meta: true,
    include_last_updated: true
  }
};

describe('POST /api/content-refresh/suggest', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    refreshQuota.__setRemaining(5);
  });

  test('returns suggestions + entitlement on success', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/content-refresh/suggest')
      .set('X-License-Key', 'test-refresh-license')
      .set('X-Site-Hash', 'site-hash')
      .set('X-Site-URL', 'https://example.test')
      .set('X-Plugin-ID', 'content_refresh')
      .send(validBody);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.suggestions.title).toBe('Fresh Title');
    expect(res.body.suggestions.sections).toHaveLength(1);
    expect(res.body.credits_used).toBe(1);
    expect(res.body.credits_remaining).toBe(4);
    expect(res.body.entitlement_state.feature_type).toBe('content_refresh');
    expect(res.body.usage.total_tokens).toBe(280);
    expect(recordUsage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        featureType: 'content_refresh',
        endpoint: 'api/content-refresh/suggest',
        creditsUsed: 1
      })
    );
    expect(JSON.stringify(res.body)).not.toMatch(/test-refresh-license/);
  });

  test('returns 402 with entitlement_state when quota is exceeded', async () => {
    refreshQuota.__setRemaining(0);
    const app = buildApp();
    const res = await request(app)
      .post('/api/content-refresh/suggest')
      .set('X-License-Key', 'test-refresh-license')
      .set('X-Site-Hash', 'site-hash')
      .set('X-Site-URL', 'https://example.test')
      .send(validBody);
    expect(res.status).toBe(402);
    expect(res.body.code).toBe('QUOTA_EXCEEDED');
    expect(res.body.entitlement_state.credits_remaining).toBe(0);
  });

  test('returns 400 for invalid request bodies', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/content-refresh/suggest')
      .set('X-License-Key', 'test-refresh-license')
      .set('X-Site-Hash', 'site-hash')
      .set('X-Site-URL', 'https://example.test')
      .send({ post: { content_excerpt: 'x'.repeat(9000) } });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_REQUEST');
  });

  test('returns 401 when no license is present', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/content-refresh/suggest')
      .set('X-Site-Hash', 'site-hash')
      .send(validBody);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('LICENSE_REQUIRED');
  });

  test('returns 429 and releases the reservation when OpenAI rate-limits', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/content-refresh/suggest')
      .set('X-License-Key', 'test-refresh-license')
      .set('X-Site-Hash', 'site-hash')
      .set('X-Site-URL', 'https://example.test')
      .send({ ...validBody, post: { ...validBody.post, url: '/fail' } });
    expect(res.status).toBe(429);
    expect(res.body.code).toBe('UPSTREAM_RATE_LIMITED');
    expect(refreshQuota.finalizeContentRefreshQuota).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ success: false })
    );
  });

  test('GET /quota returns the shared wallet snapshot', async () => {
    const app = buildApp();
    const res = await request(app)
      .get('/api/content-refresh/quota')
      .set('X-License-Key', 'test-refresh-license')
      .set('X-Site-Hash', 'site-hash')
      .set('X-Site-URL', 'https://example.test');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.feature_type).toBe('content_refresh');
    expect(res.body.source).toBe('site_quotas_shared');
  });
});
