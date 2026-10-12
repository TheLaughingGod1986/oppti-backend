/**
 * /api/linking/opportunities end-to-end pipeline with mocked OpenAI + quota.
 */
const express = require('express');
const request = require('supertest');

jest.mock('../../middleware/auth', () => {
  const passthrough = (req, _res, next) => {
    req.license = {
      id: '11111111-1111-1111-1111-111111111111',
      license_key: 'test-linking-license',
      plan: 'pro',
      status: 'active'
    };
    req.authMethod = 'license';
    next();
  };
  return {
    authMiddleware: () => passthrough,
    extractUserInfo: () => ({ user_id: null, user_email: null, plugin_version: '0.1.0' })
  };
});

jest.mock('../../lib/openaiLinking', () => ({
  DEFAULT_MAX_SUGGESTIONS: 8,
  HARD_MAX_SUGGESTIONS: 20,
  generateInternalLinkSuggestions: jest.fn(async ({ targets }) => {
    if (targets?.[0]?.id === 'fail') {
      const e = new Error('upstream rate limited');
      e.code = 'UPSTREAM_RATE_LIMITED';
      e.httpStatus = 429;
      e.isRetryable = true;
      throw e;
    }
    return {
      suggestions: [
        {
          sourcePageId: '10',
          targetPageId: String(targets[0].id),
          anchorText: 'guide to coffee',
          insertionContext: 'Read our guide to coffee roasting tips.',
          score: 88
        }
      ],
      usage: { prompt_tokens: 200, completion_tokens: 80, total_tokens: 280 },
      meta_info: { modelUsed: 'gpt-4o-mini', latencyMs: 12, maxSuggestions: 8 }
    };
  })
}));

jest.mock('../../services/linkingQuota', () => {
  let remaining = 5;
  return {
    LINKING_FEATURE_TYPE: 'internal_linking',
    reserveLinkingGenerationQuota: jest.fn(async () => {
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
        site: { id: 'site-1', site_hash: 'site-hash', license_key: 'test-linking-license' },
        reservation: {
          generation_request_id: 'gen-link-1',
          remaining_credits: remaining,
          total_limit: 5,
          credits_used: 5 - remaining,
          daily_remaining: remaining,
          daily_limit: 5,
          plan: 'free',
          quota_period_end: '2026-08-01T00:00:00.000Z'
        }
      };
    }),
    finalizeLinkingGenerationQuota: jest.fn(async () => ({ data: { status: 'succeeded' }, error: null })),
    getLinkingQuotaStatus: jest.fn(async () => ({
      feature_type: 'internal_linking',
      credits_remaining: remaining,
      total_limit: 5,
      credits_used: 5 - remaining,
      source: 'site_quotas_shared'
    })),
    buildLinkingRequestFingerprint: jest.fn(() => 'fp-linking-deterministic'),
    __setRemaining: (n) => { remaining = n; }
  };
});

jest.mock('../../services/usage', () => ({
  recordUsage: jest.fn().mockResolvedValue({ error: null })
}));

const { createLinkingRouter } = require('../../routes/linking');
const linkingQuota = require('../../services/linkingQuota');

function buildApp() {
  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use((req, res, next) => {
    req.id = 'req-linking-test';
    next();
  });
  app.use(
    '/api/linking',
    createLinkingRouter({
      supabase: {},
      checkRateLimit: async () => true
    })
  );
  return app;
}

const validBody = {
  targets: [{ id: 42, title: 'Orphan post', url: '/orphan', content_excerpt: 'About specialty coffee.' }],
  sources: [{ id: 10, title: 'Home', url: '/', content_excerpt: 'Read our guide to coffee roasting tips.' }],
  maxSuggestions: 5
};

describe('POST /api/linking/opportunities', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    linkingQuota.__setRemaining(5);
  });

  test('returns suggestions + entitlement on success', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/linking/opportunities')
      .set('X-License-Key', 'test-linking-license')
      .set('X-Site-Hash', 'site-hash')
      .set('X-Site-URL', 'https://example.test')
      .send(validBody);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.suggestions).toHaveLength(1);
    expect(res.body.opportunities).toHaveLength(1);
    expect(res.body.suggestions[0].anchorText).toBe('guide to coffee');
    expect(res.body.credits_used).toBe(1);
    expect(res.body.credits_remaining).toBe(4);
    expect(res.body.entitlement_state.feature_type).toBe('internal_linking');
  });

  test('returns 402 with entitlement_state when quota is exceeded', async () => {
    linkingQuota.__setRemaining(0);
    const app = buildApp();
    const res = await request(app)
      .post('/api/linking/opportunities')
      .set('X-License-Key', 'test-linking-license')
      .set('X-Site-Hash', 'site-hash')
      .set('X-Site-URL', 'https://example.test')
      .send(validBody);
    expect(res.status).toBe(402);
    expect(res.body.code).toBe('QUOTA_EXCEEDED');
    expect(res.body.entitlement_state).toBeTruthy();
  });

  test('returns 400 for invalid request bodies', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/linking/opportunities')
      .set('X-License-Key', 'test-linking-license')
      .set('X-Site-Hash', 'site-hash')
      .set('X-Site-URL', 'https://example.test')
      .send({ targets: [] });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_REQUEST');
  });

  test('returns 429 and releases reservation when OpenAI rate-limits', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/linking/opportunities')
      .set('X-License-Key', 'test-linking-license')
      .set('X-Site-Hash', 'site-hash')
      .set('X-Site-URL', 'https://example.test')
      .send({
        ...validBody,
        targets: [{ id: 'fail', title: 'Fail', content_excerpt: 'x' }]
      });
    expect(res.status).toBe(429);
    expect(res.body.code).toBe('UPSTREAM_RATE_LIMITED');
    expect(linkingQuota.finalizeLinkingGenerationQuota).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ success: false })
    );
  });

  test('accepts X-Site-Id header as site identity alias', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/linking/opportunities')
      .set('X-License-Key', 'test-linking-license')
      .set('X-Site-Id', 'site-hash')
      .set('X-Site-Url', 'https://example.test')
      .send(validBody);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});
