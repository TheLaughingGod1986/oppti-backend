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

  // A stored site_hash replays as X-Site-Key, so it is never logged either.
  function expectNoKeyCharacters() {
    const logged = JSON.stringify(allCalls());
    expect(logged).not.toContain('stored-hash-abc');
    for (const [, ctx] of [line('[altText] Recording usage'), line('[altText] Quota status fetched after usage')]) {
      expect(ctx).not.toHaveProperty('site_hash');
    }
    expect(logged).not.toContain(RAW_SITE_KEY);
    expect(logged).not.toContain(KEY);
    expect(logged).not.toContain(KEY.substring(0, 8));
    expect(logged).not.toContain(KEY.slice(-8));
  }

  test('stored site_hash equal to the sent X-Site-Key: logs has_site_key, not the value', async () => {
    const lines = await generate(RAW_SITE_KEY);
    for (const [, ctx] of lines) {
      expect(ctx).toEqual(expect.objectContaining({ has_license_key: true, has_site_key: true }));
      expect(ctx).not.toHaveProperty('licenseKey');
      expect(ctx).not.toHaveProperty('siteKey');
    }
    expectNoKeyCharacters();
  });

  test('a different stored site_hash is not logged either', async () => {
    const lines = await generate('stored-hash-abc');
    for (const [, ctx] of lines) {
      expect(ctx).toEqual(expect.objectContaining({ has_license_key: true, has_site_key: true }));
    }
    expectNoKeyCharacters();
  });

  test('no stored site row: raw identity hash is not logged', async () => {
    const lines = await generate(null);
    for (const [, ctx] of lines) {
      expect(ctx).toEqual(expect.objectContaining({ has_site_key: true }));
    }
    expectNoKeyCharacters();
  });
});

describe('alt-text request, quota, usage, response and accounting lines: no raw site key', () => {
  const openai = require('../../lib/openai');
  const usageService = require('../../services/usage');
  const { expectNoCredentialSlices } = require('../helpers/credentialSlices');
  let spies;
  beforeEach(() => {
    jest.clearAllMocks();
    spies = ['warn', 'info', 'debug', 'error'].map((level) => jest.spyOn(logger, level).mockImplementation(() => {}));
  });
  afterEach(() => spies.forEach((spy) => spy.mockRestore()));
  const allCalls = () => spies.flatMap((spy) => spy.mock.calls);
  const lines = (message) => allCalls().filter(([m]) => m === message);

  // Every logger call in these flows is checked, not only the changed lines.

  async function generate(site, { siteHeader = 'X-Site-Key' } = {}) {
    quotaService.reserveGenerationQuota.mockResolvedValue({
      error: null,
      reservation: { generation_request_id: 'generation_request_123', quota_source: 'site_quota' },
      site
    });
    return request(buildApp())
      .post('/api/alt-text')
      .set('X-License-Key', KEY)
      .set(siteHeader, RAW_SITE_KEY)
      .send({ image: { url: 'https://example.com/img.jpg', width: 1, height: 1 } });
  }


  test.each(['X-Site-Key', 'X-Site-Hash'])('success with stored hash equal to %s: every changed line logs has_site_key only', async (header) => {
    const res = await generate({ id: 'site_1', site_hash: RAW_SITE_KEY, license_key: KEY }, { siteHeader: header });
    expect(res.status).toBe(200);
    for (const message of ['[altText] Request received', '[altText] Quota reserved, calling OpenAI', '[usage] generation_accounting_trace', '[altText] Usage recorded successfully', '[altText] Sending response']) {
      const found = lines(message);
      expect(found.length).toBeGreaterThan(0);
      for (const [, ctx] of found) expect(ctx).toEqual(expect.objectContaining({ has_site_key: true }));
    }
    expectNoCredentialSlices(allCalls(), [RAW_SITE_KEY, KEY]);
  });

  test('a stored site hash that differs from the sent key is not logged either (it replays as X-Site-Key)', async () => {
    const res = await generate({ id: 'site_1', site_hash: 'stored-hash-abc', license_key: KEY });
    expect(res.status).toBe(200);
    expect(lines('[altText] Usage recorded successfully')[0][1]).toEqual(expect.objectContaining({ has_site_key: true, matched_by: 'X-Site-Key' }));
    expect(lines('[usage] generation_accounting_trace')[0][1]).toEqual(expect.objectContaining({ has_site_key: true }));
    expectNoCredentialSlices(allCalls(), [RAW_SITE_KEY, 'stored-hash-abc']);
  });

  test('generation failure, usage write failure and missing site id lines carry no raw site key', async () => {
    openai.generateAltText.mockRejectedValueOnce(Object.assign(new Error('provider down'), { code: 'OPENAI_ERROR', httpStatus: 503 }));
    await generate({ id: 'site_1', site_hash: RAW_SITE_KEY, license_key: KEY });
    usageService.recordUsage.mockResolvedValueOnce({ error: { message: 'insert failed' }, data: null });
    await generate({ id: 'site_1', site_hash: RAW_SITE_KEY, license_key: KEY });
    await generate({ site_hash: RAW_SITE_KEY, license_key: KEY });
    const failed = lines('[altText] Alt text generation failed');
    expect(failed.length).toBe(1);
    expect(failed[0][1]).toEqual(expect.objectContaining({ has_site_key: true }));
    expect(failed[0][1]).not.toHaveProperty('siteHash');
    expect(lines('[altText] Failed to record usage').length).toBe(1);
    expect(lines('[image-state] ledger_write_skipped').length).toBe(1);
    expectNoCredentialSlices(allCalls(), [RAW_SITE_KEY, KEY]);
  });

  test('trial generation recorded by site_trials logs has_site_key, not the trial site hash', async () => {
    quotaService.reserveGenerationQuota.mockResolvedValue({
      error: null,
      reservation: { generation_request_id: 'generation_request_trial', quota_source: 'site_trials' },
      site: { id: 'site_trial', site_hash: RAW_SITE_KEY }
    });
    const app = express();
    app.use(express.json({ limit: '8mb' }));
    app.use((req, res, next) => { req.trialMode = true; req.trialSiteHash = RAW_SITE_KEY; req.authMethod = 'trial'; next(); });
    app.use('/api/alt-text', createAltTextRouter({
      supabase: { from: () => chain() },
      redis: null,
      resultCache: new Map(),
      checkRateLimit: async () => true,
      getSiteFromHeaders: async () => null
    }));
    await request(app)
      .post('/api/alt-text')
      .set('X-Trial-Site-Hash', RAW_SITE_KEY)
      .send({ image: { url: 'https://example.com/img.jpg', width: 1, height: 1 } });
    const recorded = lines('[altText] Anonymous trial usage recorded by V2 site_trials');
    expect(recorded.length).toBe(1);
    expect(recorded[0][1]).toEqual(expect.objectContaining({ has_site_key: true }));
    const changed = ['[altText] Request received', '[altText] Quota reserved, calling OpenAI', '[usage] generation_accounting_trace',
      '[altText] Anonymous trial usage recorded by V2 site_trials', '[altText] Usage recorded successfully', '[altText] Sending response'];
    expect(allCalls().map(([m]) => m)).toEqual(expect.arrayContaining(changed));
    expectNoCredentialSlices(allCalls(), [RAW_SITE_KEY]);
  });
});
