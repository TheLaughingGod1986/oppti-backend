const express = require('express');
const request = require('supertest');
const { authMiddleware } = require('../../middleware/auth');
const { generateAltText } = require('../../lib/openai');
const quotaService = require('../../services/quota');
const usageService = require('../../services/usage');
const imageAltStateService = require('../../services/imageAltState');

jest.mock('../../lib/openai', () => ({
  generateAltText: jest.fn().mockResolvedValue({
    altText: 'mock alt',
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    meta: { modelUsed: 'mock', generation_time_ms: 1 }
  })
}));

jest.mock('../../services/quota', () => ({
  enforceQuota: jest.fn().mockResolvedValue({
    plan_type: 'pro',
    credits_used: 0,
    credits_remaining: 1000,
    total_limit: 1000
  }),
  reserveGenerationQuota: jest.fn().mockResolvedValue({
    error: null,
    reservation: {
      generation_request_id: 'generation_request_123'
    },
    site: {
      id: 'site_1',
      site_hash: 'site-key-1',
      license_key: 'key-123'
    }
  }),
  finalizeGenerationQuotaReservation: jest.fn().mockResolvedValue({ error: null }),
  getQuotaStatus: jest.fn().mockResolvedValue({
    plan_type: 'pro',
    credits_used: 0,
    credits_remaining: 1000,
    total_limit: 1000
  })
}));

jest.mock('../../services/usage', () => ({
  recordUsage: jest.fn().mockResolvedValue({ error: null, data: { id: 'usage_1' } })
}));

jest.mock('../../services/imageAltState', () => ({
  upsertGeneratedImageAltState: jest.fn().mockResolvedValue({
    data: { id: 'image_state_1', current_state: 'NEEDS_REVIEW' },
    error: null
  })
}));

const { createAltTextRouter } = require('../../routes/altText');

/**
 * Creates a chainable mock that supports all Supabase query methods.
 */
function createChainableMock(resolveData = null, resolveError = null) {
  const chainable = {
    select: () => chainable,
    eq: () => chainable,
    neq: () => chainable,
    gt: () => chainable,
    gte: () => chainable,
    lt: () => chainable,
    lte: () => chainable,
    like: () => chainable,
    ilike: () => chainable,
    is: () => chainable,
    in: () => chainable,
    order: () => chainable,
    limit: () => chainable,
    insert: () => chainable,
    update: () => chainable,
    upsert: () => chainable,
    single: () => Promise.resolve({ data: resolveData, error: resolveError }),
    maybeSingle: () => Promise.resolve({ data: resolveData, error: resolveError }),
    then: (resolve, reject) => Promise.resolve({ data: resolveData ? [resolveData] : [], error: resolveError }).then(resolve, reject)
  };
  return chainable;
}

function createSupabaseMock(licenseRow = null) {
  return {
    from: (table) => {
      if (table === 'licenses') {
        return createChainableMock(licenseRow);
      }
      return createChainableMock(null);
    }
  };
}

function createAnonymousTrialSupabaseMock({ licenseRow = null, trialUsage = [], sites = [] } = {}) {
  const state = {
    licenses: licenseRow ? [licenseRow] : [],
    trialUsage: [...trialUsage],
    sites: [...sites]
  };
  let nextSiteId = sites.length + 1;

  function filterRows(rows, filters) {
    return rows.filter((row) => filters.every(({ column, value }) => row[column] === value));
  }

  function buildQuery(rows, { countMode = false } = {}) {
    const filters = [];
    const chain = {
      select(_columns, options = {}) {
        return buildQuery(rows, { countMode: Boolean(options?.head && options?.count === 'exact') });
      },
      eq(column, value) {
        filters.push({ column, value });
        return chain;
      },
      order() {
        return chain;
      },
      limit() {
        return chain;
      },
      maybeSingle: async () => {
        const results = filterRows(rows, filters);
        return { data: results[0] || null, error: null };
      },
      single: async () => {
        const results = filterRows(rows, filters);
        return { data: results[0] || null, error: null };
      },
      then(resolve, reject) {
        const results = filterRows(rows, filters);
        const payload = countMode
          ? { count: results.length, error: null }
          : { data: results, error: null };
        return Promise.resolve(payload).then(resolve, reject);
      }
    };
    return chain;
  }

  return {
    _state: state,
    from(table) {
      if (table === 'licenses') {
        return buildQuery(state.licenses);
      }

      if (table === 'trial_usage') {
        return {
          select(_columns, options = {}) {
            return buildQuery(state.trialUsage, { countMode: Boolean(options?.head && options?.count === 'exact') });
          },
          insert(payload) {
            state.trialUsage.push({
              id: `trial_${state.trialUsage.length + 1}`,
              created_at: new Date().toISOString(),
              ...payload
            });
            return Promise.resolve({ data: payload, error: null });
          }
        };
      }

      if (table === 'sites') {
        return {
          select() {
            return buildQuery(state.sites);
          },
          insert(payload) {
            const row = {
              id: `site_${nextSiteId++}`,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
              ...payload
            };
            state.sites.push(row);
            return {
              select() {
                return {
                  single: async () => ({ data: row, error: null })
                };
              }
            };
          },
          update(payload) {
            return {
              eq(column, value) {
                const row = state.sites.find((site) => site[column] === value);
                if (row) Object.assign(row, payload);
                return Promise.resolve({ data: row || null, error: null });
              }
            };
          }
        };
      }

      return createChainableMock(null);
    }
  };
}

describe('POST /api/alt-text', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.ANONYMOUS_TRIAL_CREDITS = '5';
  });

  test('requires image payload', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/alt-text', createAltTextRouter({
      supabase: createSupabaseMock(),
      redis: null,
      resultCache: new Map(),
      checkRateLimit: async () => true,
      getSiteFromHeaders: async () => ({ quota: 50, used: 0, remaining: 50 })
    }));
    const res = await request(app).post('/api/alt-text').send({});
    expect(res.status).toBe(400);
  });

  test('returns alt text on success', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/alt-text', createAltTextRouter({
      supabase: createSupabaseMock(),
      redis: null,
      resultCache: new Map(),
      checkRateLimit: async () => true,
      getSiteFromHeaders: async () => ({ quota: 50, used: 0, remaining: 50 })
    }));
    const res = await request(app).post('/api/alt-text').send({
      image: { url: 'https://example.com/img.jpg', width: 1, height: 1 }
    });
    expect(res.status).toBe(200);
    expect(res.body.altText).toBe('mock alt');
  });

  test('persists image state ledger on successful generation', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/alt-text', createAltTextRouter({
      supabase: createSupabaseMock({
        id: '11111111-1111-1111-1111-111111111111',
        license_key: 'key-123',
        plan: 'pro',
        status: 'active'
      }),
      redis: null,
      resultCache: new Map(),
      checkRateLimit: async () => true,
      getSiteFromHeaders: async () => ({ quota: 50, used: 0, remaining: 50 })
    }));

    const res = await request(app).post('/api/alt-text').send({
      image: {
        attachment_id: 321,
        url: 'https://example.com/img.jpg',
        width: 1,
        height: 1
      },
      context: {
        pageTitle: 'Media library'
      }
    });

    expect(res.status).toBe(200);
    expect(imageAltStateService.upsertGeneratedImageAltState).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      siteId: 'site_1',
      altText: 'mock alt',
      generationRequestId: 'generation_request_123',
      image: expect.objectContaining({
        url: 'https://example.com/img.jpg'
      }),
      context: expect.objectContaining({
        pageTitle: 'Media library'
      })
    }));
  });

  test('uses logged-in quota when trial headers are stale', async () => {
    const supabase = createSupabaseMock({
      id: '11111111-1111-1111-1111-111111111111',
      license_key: 'key-123',
      plan: 'pro',
      status: 'active'
    });
    const app = express();
    app.use(express.json());
    app.use(authMiddleware({ supabase }));
    app.use('/api/alt-text', createAltTextRouter({
      supabase,
      redis: null,
      resultCache: new Map(),
      checkRateLimit: async () => true,
      getSiteFromHeaders: async () => ({ quota: 50, used: 0, remaining: 50 })
    }));

    const res = await request(app)
      .post('/api/alt-text')
      .set('X-License-Key', 'key-123')
      .set('X-Trial-Mode', 'true')
      .set('X-Trial-Site-Hash', 'trial-site')
      .send({
        image: { url: 'https://example.com/img.jpg', width: 1, height: 1 }
      });

    expect(res.status).toBe(200);
    expect(res.body.altText).toBe('mock alt');
    expect(usageService.recordUsage).toHaveBeenCalledTimes(1);
    expect(usageService.recordUsage).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      userId: '11111111-1111-1111-1111-111111111111',
      endpoint: 'api/alt-text',
      status: 'success'
    }));
  });

  test('falls back to site owner when no authenticated user is present', async () => {
    quotaService.reserveGenerationQuota.mockResolvedValueOnce({
      error: null,
      reservation: { generation_request_id: 'generation_request_456' },
      site: {
        id: 'site_2',
        site_hash: 'site-key-2',
        license_key: 'key-123',
        owner_user_id: '22222222-2222-2222-2222-222222222222'
      }
    });

    const app = express();
    app.use(express.json());
    app.use('/api/alt-text', createAltTextRouter({
      supabase: createSupabaseMock({ id: '11111111-1111-1111-1111-111111111111', license_key: 'key-123' }),
      redis: null,
      resultCache: new Map(),
      checkRateLimit: async () => true,
      getSiteFromHeaders: async () => ({ quota: 50, used: 0, remaining: 50 })
    }));

    const res = await request(app).post('/api/alt-text').send({
      image: { url: 'https://example.com/img.jpg', width: 1, height: 1 }
    });

    expect(res.status).toBe(200);
    expect(usageService.recordUsage).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      userId: '22222222-2222-2222-2222-222222222222',
      siteHash: 'site-key-2'
    }));
  });

  test('anonymous generation succeeds and persists quota across requests', async () => {
    quotaService.reserveGenerationQuota.mockResolvedValue({
      error: null,
      reservation: {
        generation_request_id: 'generation_request_anon',
        quota_source: 'legacy_trial'
      }
    });
    quotaService.getQuotaStatus.mockResolvedValue({
      error: 'SITE_QUOTA_V2_UNAVAILABLE'
    });

    const supabase = createAnonymousTrialSupabaseMock();
    const app = express();
    app.use(express.json());
    app.use(authMiddleware({ supabase }));
    app.use('/api/alt-text', createAltTextRouter({
      supabase,
      redis: null,
      resultCache: new Map(),
      checkRateLimit: async () => true,
      getSiteFromHeaders: async () => null
    }));

    const first = await request(app)
      .post('/api/alt-text')
      .set('X-Site-Key', 'site-anon-1')
      .set('X-Site-URL', 'https://example.com')
      .set('X-Anon-Id', 'anon-dashboard-1')
      .send({
        image: { url: 'https://example.com/img.jpg', width: 1, height: 1 }
      });

    expect(first.status).toBe(200);
    expect(first.body.auth_state).toBe('anonymous');
    expect(first.body.quota_type).toBe('trial');
    expect(first.body.credits_total).toBe(5);
    expect(first.body.credits_used).toBe(1);
    expect(first.body.credits_remaining).toBe(4);
    expect(first.body.anon_id).toBe('anon-dashboard-1');
    expect(first.body.anonymous).toEqual(expect.objectContaining({
      anon_id: 'anon-dashboard-1',
      used: 1,
      remaining: 4,
      total: 5,
      signup_required: false
    }));
    expect(quotaService.reserveGenerationQuota).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      quotaMode: 'trial',
      requestMetadata: expect.objectContaining({
        anon_id: 'anon-dashboard-1',
        anonymous_risk_key: expect.any(String),
        anonymous_ip_hash: expect.any(String)
      })
    }));

    const second = await request(app)
      .post('/api/alt-text')
      .set('X-Site-Key', 'site-anon-1')
      .set('X-Site-URL', 'https://example.com')
      .set('X-Anon-Id', 'anon-dashboard-1')
      .send({
        image: { url: 'https://example.com/img-2.jpg', width: 1, height: 1 }
      });

    expect(second.status).toBe(200);
    expect(second.body.anonymous).toEqual(expect.objectContaining({
      used: 2,
      remaining: 3,
      total: 5
    }));
    expect(supabase._state.trialUsage).toHaveLength(2);
    expect(usageService.recordUsage).not.toHaveBeenCalled();
  });

  test('anonymous generation returns trial counters even when quota status includes free-plan monthly counters', async () => {
    quotaService.reserveGenerationQuota.mockResolvedValue({
      error: null,
      reservation: {
        generation_request_id: 'generation_request_trial_v2',
        quota_source: 'trial'
      }
    });
    quotaService.getQuotaStatus.mockResolvedValue({
      error: null,
      plan_type: 'free',
      credits_used: 0,
      credits_remaining: 50,
      total_limit: 50,
      trial: {
        total_trial_credits: 5,
        used_trial_credits: 1
      }
    });

    const supabase = createAnonymousTrialSupabaseMock();
    const app = express();
    app.use(express.json());
    app.use(authMiddleware({ supabase }));
    app.use('/api/alt-text', createAltTextRouter({
      supabase,
      redis: null,
      resultCache: new Map(),
      checkRateLimit: async () => true,
      getSiteFromHeaders: async () => null
    }));

    const res = await request(app)
      .post('/api/alt-text')
      .set('X-Site-Key', 'site-anon-v2')
      .set('X-Site-URL', 'https://example.com')
      .set('X-Anon-Id', 'anon-dashboard-v2')
      .send({
        image: { url: 'https://example.com/img.jpg', width: 1, height: 1 }
      });

    expect(res.status).toBe(200);
    expect(res.body.auth_state).toBe('anonymous');
    expect(res.body.quota_type).toBe('trial');
    expect(res.body.credits_total).toBe(5);
    expect(res.body.credits_used).toBe(1);
    expect(res.body.credits_remaining).toBe(4);
    expect(res.body.total_limit).toBe(5);
    expect(res.body.limit).toBe(5);
    expect(res.body.free_plan_offer).toBe(50);
    expect(supabase._state.trialUsage).toHaveLength(0);
  });

  test('same site does not mint a fresh anonymous trial for a different anon id', async () => {
    quotaService.reserveGenerationQuota.mockResolvedValue({
      error: null,
      reservation: {
        generation_request_id: 'generation_request_exhausted',
        quota_source: 'legacy_trial'
      }
    });
    quotaService.getQuotaStatus.mockResolvedValue({
      error: 'SITE_QUOTA_V2_UNAVAILABLE'
    });

    const supabase = createAnonymousTrialSupabaseMock({
      trialUsage: Array.from({ length: 5 }, (_, index) => ({
        id: `trial_${index + 1}`,
        site_hash: 'site-anon-2',
        anon_id: `anon-${index}`,
        created_at: new Date().toISOString()
      }))
    });
    const app = express();
    app.use(express.json());
    app.use(authMiddleware({ supabase }));
    app.use('/api/alt-text', createAltTextRouter({
      supabase,
      redis: null,
      resultCache: new Map(),
      checkRateLimit: async () => true,
      getSiteFromHeaders: async () => null
    }));

    const res = await request(app)
      .post('/api/alt-text')
      .set('X-Site-Key', 'site-anon-2')
      .set('X-Site-URL', 'https://example.com')
      .set('X-Anon-Id', 'brand-new-anon-id')
      .send({
        image: { url: 'https://example.com/img.jpg', width: 1, height: 1 }
      });

    expect(res.status).toBe(402);
    expect(res.body.code).toBe('TRIAL_EXHAUSTED');
    expect(res.body.auth_state).toBe('anonymous');
    expect(res.body.quota_type).toBe('trial');
    expect(res.body.quota_state).toBe('exhausted');
    expect(res.body.credits_total).toBe(5);
    expect(res.body.credits_used).toBe(5);
    expect(res.body.credits_remaining).toBe(0);
    expect(res.body.signup_required).toBe(true);
    expect(res.body.anonymous).toEqual(expect.objectContaining({
      used: 5,
      remaining: 0,
      total: 5,
      signup_required: true
    }));
    expect(generateAltText).not.toHaveBeenCalled();
  });
});
