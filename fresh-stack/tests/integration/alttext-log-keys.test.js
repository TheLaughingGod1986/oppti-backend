const express = require('express');
const request = require('supertest');
const logger = require('../../lib/logger');
const quotaService = require('../../services/quota');

jest.mock('../../lib/openai', () => ({
  generateAltText: jest.fn().mockResolvedValue({
    altText: 'mock alt',
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    meta: { modelUsed: 'mock', generation_time_ms: 1 }
  })
}));
jest.mock('../../lib/posthog', () => ({ captureServerEvent: jest.fn().mockResolvedValue({ ok: true }) }));
jest.mock('../../services/quota', () => ({
  reserveGenerationQuota: jest.fn(),
  finalizeGenerationQuotaReservation: jest.fn().mockResolvedValue({ error: null }),
  getQuotaStatus: jest.fn().mockResolvedValue({ plan_type: 'pro', credits_used: 1, credits_remaining: 999, total_limit: 1000 })
}));
jest.mock('../../services/usage', () => ({
  recordUsage: jest.fn().mockResolvedValue({ error: null, data: { id: 'usage_1' } })
}));
jest.mock('../../services/imageAltState', () => ({
  upsertGeneratedImageAltState: jest.fn().mockResolvedValue({ data: { id: 'state_1' }, error: null })
}));

const { createAltTextRouter } = require('../../routes/altText');

const KEY = 'QA-FAKE-LICENSE-KEY-0001';
const RAW_SITE_KEY = 'qa-raw-site-key-secret-0001';

function chain() {
  const c = {
    select: () => c, eq: () => c, order: () => c, limit: () => c, insert: () => c, update: () => c, upsert: () => c,
    single: () => Promise.resolve({ data: null, error: null }),
    maybeSingle: () => Promise.resolve({ data: null, error: null }),
    then: (resolve, reject) => Promise.resolve({ data: [], error: null }).then(resolve, reject)
  };
  return c;
}

function buildApp() {
  const app = express();
  app.use(express.json({ limit: '8mb' }));
  app.use((req, res, next) => { req.license = { id: '11111111-2222-4333-8444-555555555555', license_key: KEY, plan: 'pro', status: 'active' }; req.authMethod = 'license'; next(); });
  app.use('/api/alt-text', createAltTextRouter({
    supabase: { from: () => chain() },
    redis: null,
    resultCache: new Map(),
    checkRateLimit: async () => true,
    getSiteFromHeaders: async () => null
  }));
  return app;
}

describe('alt-text Recording usage / Quota status lines: no licence key characters, no raw site key', () => {
  let spies;
  beforeEach(() => {
    jest.clearAllMocks();
    spies = ['warn', 'info', 'debug', 'error'].map((level) => jest.spyOn(logger, level).mockImplementation(() => {}));
  });
  afterEach(() => spies.forEach((spy) => spy.mockRestore()));
  const allCalls = () => spies.flatMap((spy) => spy.mock.calls);
  const line = (message) => allCalls().find(([m]) => m === message);

  async function generate(storedHash) {
    quotaService.reserveGenerationQuota.mockResolvedValue({
      error: null,
      reservation: { generation_request_id: 'generation_request_123' },
      site: { id: 'site_1', site_hash: storedHash, license_key: KEY }
    });
    const res = await request(buildApp())
      .post('/api/alt-text')
      .set('X-License-Key', KEY)
      .set('X-Site-Key', RAW_SITE_KEY)
      .send({ image: { url: 'https://example.com/img.jpg', width: 1, height: 1 } });
    expect(res.status).toBe(200);
    return [line('[altText] Recording usage'), line('[altText] Quota status fetched after usage')];
  }

  // Scope of this check: the two usage lines changed here. Other alt-text log
  // lines still log the identity site_hash (see NOTES, identity follow-up).
  function expectNoKeyCharacters() {
    const logged = JSON.stringify([line('[altText] Recording usage'), line('[altText] Quota status fetched after usage')]);
    expect(logged).not.toContain(RAW_SITE_KEY);
    expect(logged).not.toContain(KEY);
    expect(logged).not.toContain(KEY.substring(0, 8));
    expect(logged).not.toContain(KEY.slice(-8));
  }

  test('stored site_hash equal to the sent X-Site-Key: logs has_site_key, not the value', async () => {
    const lines = await generate(RAW_SITE_KEY);
    for (const [, ctx] of lines) {
      expect(ctx).toEqual(expect.objectContaining({ has_license_key: true, has_site_key: true, site_hash: null }));
      expect(ctx).not.toHaveProperty('licenseKey');
      expect(ctx).not.toHaveProperty('siteKey');
    }
    expectNoKeyCharacters();
  });

  test('a different stored site_hash is logged; the raw key never is', async () => {
    const lines = await generate('stored-hash-abc');
    for (const [, ctx] of lines) {
      expect(ctx).toEqual(expect.objectContaining({ has_license_key: true, has_site_key: true, site_hash: 'stored-hash-abc' }));
    }
    expectNoKeyCharacters();
  });

  test('no stored site row: raw identity hash is not logged', async () => {
    const lines = await generate(null);
    for (const [, ctx] of lines) {
      expect(ctx).toEqual(expect.objectContaining({ has_site_key: true, site_hash: null }));
    }
    expectNoKeyCharacters();
  });
});
