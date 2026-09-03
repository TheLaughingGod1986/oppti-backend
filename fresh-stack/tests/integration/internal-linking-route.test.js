/**
 * /api/internal-linking/suggest end-to-end pipeline with mocked OpenAI + quota.
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
    extractUserInfo: () => ({ user_id: null, user_email: null, plugin_version: '1.0.0' })
  };
});

jest.mock('../../lib/openaiInternalLinking', () => ({
  generateInternalLinkSuggestions: jest.fn(async ({ source, candidates }) => {
    if (source?.url === '/fail') {
      const e = new Error('upstream rate limited');
      e.code = 'UPSTREAM_RATE_LIMITED';
      e.httpStatus = 429;
      e.isRetryable = true;
      throw e;
    }
    // Suggest a link to the first candidate.
    const candidate = candidates[0];
    return {
      suggestions: [{
        target_index: 0,
        target_id: candidate.id ?? null,
        target_url: candidate.url ?? null,
        target_title: candidate.title ?? null,
        anchor: 'topic clusters',
        phrase: 'topic clusters',
        reason: 'Closely related pillar content.',
        score: 82
      }],
      usage: { prompt_tokens: 200, completion_tokens: 60, total_tokens: 260 },
      meta_info: { modelUsed: 'gpt-4o-mini', latencyMs: 5, candidate_count: candidates.length }
    };
  })
}));

jest.mock('../../services/internalLinkingQuota', () => {
  let remaining = 5;
  return {
    INTERNAL_LINKING_FEATURE_TYPE: 'internal_linking',
    reserveInternalLinkingQuota: jest.fn(async () => {
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
          generation_request_id: 'gen-1',
          remaining_credits: remaining,
          total_limit: 5,
          credits_used: 5 - remaining,
          plan: 'free',
          quota_period_end: '2026-07-01T00:00:00.000Z'
        }
      };
    }),
    finalizeInternalLinkingQuota: jest.fn(async () => ({ data: { status: 'succeeded' }, error: null })),
    getInternalLinkingQuotaStatus: jest.fn(async () => ({
      feature_type: 'internal_linking',
      credits_remaining: remaining,
      total_limit: 5,
      credits_used: 5 - remaining,
      source: 'site_quotas_shared'
    })),
    buildInternalLinkingRequestFingerprint: jest.fn(() => 'fp-deterministic'),
    __setRemaining: (n) => { remaining = n; }
  };
});

jest.mock('../../services/usage', () => ({
  recordUsage: jest.fn().mockResolvedValue({ error: null })
}));

const { createInternalLinkingRouter } = require('../../routes/internalLinking');
const linkingQuota = require('../../services/internalLinkingQuota');

function buildApp() {
  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use((req, res, next) => {
    req.id = 'req-test';
    next();
  });
  app.use(
    '/api/internal-linking',
    createInternalLinkingRouter({
      supabase: {},
      checkRateLimit: async () => true
    })
  );
  return app;
}

const validBody = {
  source: { id: 1, url: '/seo-guide', title: 'SEO Guide', content_excerpt: 'A strong content strategy relies on topic clusters.' },
  candidates: [
    { id: 2, url: '/topic-clusters', title: 'Building Topic Clusters' },
    { id: 3, url: '/keyword-research', title: 'Keyword Research 101' }
  ]
};

describe('POST /api/internal-linking/suggest', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    linkingQuota.__setRemaining(5);
  });

  test('returns suggestions + entitlement on success', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/internal-linking/suggest')
      .set('X-License-Key', 'test-linking-license')
      .set('X-Site-Hash', 'site-hash')
      .set('X-Site-URL', 'https://example.test')
      .send(validBody);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.suggestions).toHaveLength(1);
    expect(res.body.suggestions[0].target_url).toBe('/topic-clusters');
    expect(res.body.suggestions[0].phrase).toBe('topic clusters');
    expect(res.body.credits_used).toBe(1);
    expect(res.body.credits_remaining).toBe(4);
    expect(res.body.entitlement_state.feature_type).toBe('internal_linking');
    expect(res.body.usage.total_tokens).toBe(260);
  });

  test('returns 402 with entitlement_state when quota is exceeded', async () => {
    linkingQuota.__setRemaining(0);
    const app = buildApp();
    const res = await request(app)
      .post('/api/internal-linking/suggest')
      .set('X-License-Key', 'test-linking-license')
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
      .post('/api/internal-linking/suggest')
      .set('X-License-Key', 'test-linking-license')
      .set('X-Site-Hash', 'site-hash')
      .set('X-Site-URL', 'https://example.test')
      .send({ source: { url: '/x' } /* missing candidates */ });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_REQUEST');
  });

  test('returns 401 when no license is present', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/internal-linking/suggest')
      .set('X-Site-Hash', 'site-hash')
      .send(validBody);
    // The mocked auth middleware is not mounted here, so no license resolves.
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('LICENSE_REQUIRED');
  });

  test('returns 429 and releases the reservation when OpenAI rate-limits', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/internal-linking/suggest')
      .set('X-License-Key', 'test-linking-license')
      .set('X-Site-Hash', 'site-hash')
      .set('X-Site-URL', 'https://example.test')
      .send({ ...validBody, source: { ...validBody.source, url: '/fail' } });
    expect(res.status).toBe(429);
    expect(res.body.code).toBe('UPSTREAM_RATE_LIMITED');
    expect(linkingQuota.finalizeInternalLinkingQuota).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ success: false })
    );
  });

  test('GET /quota returns the shared wallet snapshot', async () => {
    const app = buildApp();
    const res = await request(app)
      .get('/api/internal-linking/quota')
      .set('X-License-Key', 'test-linking-license')
      .set('X-Site-Hash', 'site-hash')
      .set('X-Site-URL', 'https://example.test');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.feature_type).toBe('internal_linking');
    expect(res.body.source).toBe('site_quotas_shared');
  });
});
