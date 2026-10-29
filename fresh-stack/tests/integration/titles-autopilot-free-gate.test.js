/**
 * Titles Autopilot (X-Request-Source: beepbeep_titles_autopilot) is a paid
 * feature. Free accounts: logged only by default, refused (403) when
 * TITLES_AUTOPILOT_FREE_BLOCK_ENFORCE is on. Paid accounts always allowed.
 */
const express = require('express');
const request = require('supertest');

jest.mock('../../middleware/auth', () => ({
  authMiddleware: () => (req, _res, next) => next(),
  extractUserInfo: () => ({ user_id: null, user_email: null, plugin_version: '1.0.30' })
}));

jest.mock('../../lib/openaiTitles', () => ({
  generateTitleAndMeta: jest.fn(async () => ({
    title: 'A title',
    meta: 'A meta description.',
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    meta_info: { modelUsed: 'test-model' }
  })),
  buildTitlesPrompt: jest.fn()
}));

const mockQuota = { plan: 'free', statusError: null };
jest.mock('../../services/titleQuota', () => ({
  TITLES_FEATURE_TYPE: 'title_meta',
  reserveTitleGenerationQuota: jest.fn(async () => ({
    error: null,
    site: { id: 'site-1', site_hash: 'site-hash', license_key: 'lic-1' },
    reservation: { generation_request_id: 'gen-1', remaining_credits: 10, total_limit: 50, credits_used: 40, plan: mockQuota.plan }
  })),
  finalizeTitleGenerationQuota: jest.fn(async () => ({ data: { status: 'succeeded' }, error: null })),
  getTitleQuotaStatus: jest.fn(async () => (mockQuota.statusError
    ? { error: mockQuota.statusError, status: 404 }
    : { feature_type: 'title_meta', site_id: 'site-1', credits_remaining: 10, total_limit: 50, plan: mockQuota.plan })),
  buildTitleRequestFingerprint: jest.fn(() => 'fp')
}));

jest.mock('../../services/usage', () => ({ recordUsage: jest.fn().mockResolvedValue({ error: null }) }));

const logger = require('../../lib/logger');
const titleQuota = require('../../services/titleQuota');
const { createTitlesRouter, TITLES_AUTOPILOT_SOURCE } = require('../../routes/titles');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.id = 'req-autopilot';
    req.license = { id: 'acct-1', license_key: 'lic-1', plan: 'pro', status: 'active' }; // legacy column says pro; wallet decides
    next();
  });
  app.use('/api/titles', createTitlesRouter({
    supabase: {},
    checkRateLimit: async () => true,
    createJob: jest.fn(async () => 'job-1'),
    getJobRecord: jest.fn(async () => null)
  }));
  return app;
}

function generate({ source = TITLES_AUTOPILOT_SOURCE } = {}) {
  const req = request(buildApp())
    .post('/api/titles/generate')
    .set('X-License-Key', 'lic-1')
    .set('X-Site-Hash', 'site-hash')
    .set('X-Site-URL', 'https://shop-one.example');
  if (source) req.set('X-Request-Source', source);
  return req.send({ page: { url: '/about', h1: 'About' } });
}

function bulk({ source = TITLES_AUTOPILOT_SOURCE } = {}) {
  const req = request(buildApp())
    .post('/api/titles/jobs')
    .set('X-License-Key', 'lic-1')
    .set('X-Site-Hash', 'site-hash');
  if (source) req.set('X-Request-Source', source);
  return req.send({ pages: [{ url: '/a', h1: 'A' }] });
}

let warnSpy;
const saved = process.env.TITLES_AUTOPILOT_FREE_BLOCK_ENFORCE;
beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.TITLES_AUTOPILOT_FREE_BLOCK_ENFORCE;
  mockQuota.plan = 'free';
  mockQuota.statusError = null;
  warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {});
  jest.spyOn(logger, 'info').mockImplementation(() => {});
});
afterEach(() => {
  jest.restoreAllMocks();
  if (saved === undefined) delete process.env.TITLES_AUTOPILOT_FREE_BLOCK_ENFORCE;
  else process.env.TITLES_AUTOPILOT_FREE_BLOCK_ENFORCE = saved;
});

const gateLogs = () => warnSpy.mock.calls.filter(([m]) => m === '[titles] autopilot_free_account');

describe('Titles Autopilot Free gate', () => {
  test('flag off (default): Free autopilot generate is allowed and logged', async () => {
    const res = await generate();
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(gateLogs()).toHaveLength(1);
    expect(gateLogs()[0][1]).toMatchObject({ route: 'titles_generate', enforced: false, action: 'allowed_log_only', account_id: 'acct-1' });
  });

  test('flag on: Free autopilot generate is refused with 403 before any credit is reserved', async () => {
    process.env.TITLES_AUTOPILOT_FREE_BLOCK_ENFORCE = 'true';
    const res = await generate();
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ success: false, code: 'AUTOPILOT_REQUIRES_PAID_PLAN', upgrade_required: true });
    expect(titleQuota.reserveTitleGenerationQuota).not.toHaveBeenCalled();
    expect(gateLogs()[0][1]).toMatchObject({ enforced: true, action: 'refused' });
  });

  test('flag on: Free bulk job with the autopilot header is refused too', async () => {
    process.env.TITLES_AUTOPILOT_FREE_BLOCK_ENFORCE = '1';
    const res = await bulk();
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('AUTOPILOT_REQUIRES_PAID_PLAN');
  });

  test.each(['starter', 'pro', 'agency'])('flag on: paid (%s) autopilot is allowed, nothing logged', async (plan) => {
    process.env.TITLES_AUTOPILOT_FREE_BLOCK_ENFORCE = 'true';
    mockQuota.plan = plan;
    const res = await generate();
    expect(res.status).toBe(200);
    expect(gateLogs()).toHaveLength(0);
  });

  test('flag on: Free manual generation (no autopilot header) is unaffected and does no extra lookup', async () => {
    process.env.TITLES_AUTOPILOT_FREE_BLOCK_ENFORCE = 'true';
    const res = await generate({ source: 'beepbeep_titles_manual' });
    expect(res.status).toBe(200);
    expect(titleQuota.getTitleQuotaStatus).not.toHaveBeenCalled();
    const none = await generate({ source: null });
    expect(none.status).toBe(200);
  });

  test('flag on: header match is case/space-insensitive', async () => {
    process.env.TITLES_AUTOPILOT_FREE_BLOCK_ENFORCE = 'true';
    const res = await generate({ source: '  BeepBeep_Titles_Autopilot ' });
    expect(res.status).toBe(403);
  });

  test('flag on: an unresolved plan never blocks (fails open, logged)', async () => {
    process.env.TITLES_AUTOPILOT_FREE_BLOCK_ENFORCE = 'true';
    mockQuota.statusError = 'SITE_NOT_FOUND';
    const res = await generate();
    expect(res.status).toBe(200);
    expect(warnSpy.mock.calls.some(([m]) => m === '[titles] autopilot_plan_unresolved')).toBe(true);
  });
});
