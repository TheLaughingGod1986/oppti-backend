const express = require('express');
const request = require('supertest');

jest.mock('../../lib/openai', () => ({
  generateAltText: jest.fn().mockResolvedValue({
    altText: 'mock alt',
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    meta: { modelUsed: 'mock', generation_time_ms: 1 }
  })
}));

jest.mock('../../lib/posthog', () => ({
  captureServerEvent: jest.fn().mockResolvedValue({ ok: true })
}));

jest.mock('../../services/quota', () => ({
  reserveGenerationQuota: jest.fn(),
  finalizeGenerationQuotaReservation: jest.fn().mockResolvedValue({ error: null }),
  getQuotaStatus: jest.fn().mockResolvedValue({
    plan_type: 'free',
    credits_used: 0,
    credits_remaining: 25,
    total_limit: 25
  })
}));

jest.mock('../../services/usage', () => ({
  recordUsage: jest.fn().mockResolvedValue({ error: null, data: { id: 'usage_1' } })
}));

jest.mock('../../services/imageAltState', () => ({
  upsertGeneratedImageAltState: jest.fn().mockResolvedValue({ data: { id: 'state_1' }, error: null })
}));

const quotaService = require('../../services/quota');
const { recordUsage } = require('../../services/usage');
const { createAltTextRouter } = require('../../routes/altText');
const { authStateForPlan } = require('../../lib/authState');

const LICENSE_ID = '33333333-3333-4333-8333-333333333333';

function createSupabase(licenses) {
  const chainFor = (rows) => {
    let filtered = rows;
    const chain = {
      select: () => chain,
      eq: (column, value) => { filtered = filtered.filter((row) => row[column] === value); return chain; },
      order: () => chain,
      limit: () => chain,
      insert: () => chain,
      update: () => chain,
      upsert: () => chain,
      single: () => Promise.resolve({ data: filtered[0] || null, error: null }),
      maybeSingle: () => Promise.resolve({ data: filtered[0] || null, error: null }),
      then: (resolve, reject) => Promise.resolve({ data: filtered, error: null }).then(resolve, reject)
    };
    return chain;
  };
  return { from: (table) => chainFor(table === 'licenses' ? licenses : []) };
}

function buildApp(plan) {
  const app = express();
  app.use(express.json({ limit: '8mb' }));
  app.use('/api/alt-text', createAltTextRouter({
    supabase: createSupabase([{ id: LICENSE_ID, license_key: 'key-auth-state', plan }]),
    redis: null,
    resultCache: new Map(),
    checkRateLimit: async () => true,
    getSiteFromHeaders: async () => null
  }));
  return app;
}

describe('usage_logs auth_state follows the licence plan', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    quotaService.reserveGenerationQuota.mockResolvedValue({
      error: null,
      reservation: { generation_request_id: 'generation_request_auth_state' },
      site: { id: 'site_auth_state', site_hash: 'site-auth-state', license_key: 'key-auth-state' }
    });
  });

  test.each([
    ['free', 'authenticated_free'],
    ['starter', 'authenticated_paid'],
    ['pro', 'authenticated_paid'],
    ['agency', 'authenticated_paid']
  ])('a %s licence is recorded as %s', async (plan, expected) => {
    const res = await request(buildApp(plan))
      .post('/api/alt-text')
      .set('X-Site-Key', 'site-auth-state')
      .send({ image: { url: 'https://example.com/img.jpg', width: 1, height: 1 } });

    expect(res.status).toBe(200);
    expect(recordUsage).toHaveBeenCalledTimes(1);
    expect(recordUsage.mock.calls[0][1]).toEqual(expect.objectContaining({
      licenseId: LICENSE_ID,
      authState: expected
    }));
  });

  test('a client-sent auth state cannot relabel a free licence as paid', async () => {
    const res = await request(buildApp('free'))
      .post('/api/alt-text')
      .set('X-Site-Key', 'site-auth-state')
      .set('X-Auth-State', 'authenticated_paid')
      .send({ image: { url: 'https://example.com/img.jpg', width: 1, height: 1 } });

    expect(res.status).toBe(200);
    expect(recordUsage.mock.calls[0][1].authState).toBe('authenticated_free');
  });
});

describe('authStateForPlan', () => {
  test.each([
    [null, 'authenticated_free'],
    ['', 'authenticated_free'],
    ['free', 'authenticated_free'],
    ['FREE', 'authenticated_free'],
    ['trial', 'authenticated_free'],
    ['starter', 'authenticated_paid'],
    ['pro', 'authenticated_paid'],
    ['growth', 'authenticated_paid'],
    ['agency', 'authenticated_paid'],
    ['enterprise', 'authenticated_paid']
  ])('%p -> %s', (plan, expected) => {
    expect(authStateForPlan(plan)).toBe(expected);
  });
});
