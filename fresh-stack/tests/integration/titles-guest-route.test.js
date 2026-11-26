/**
 * Titles guest first result: POST /api/titles/generate without an account.
 *
 * Runs the real auth middleware, titles router and titleQuota adapter. Only
 * the database edge (services/siteQuota reserve/finalize), OpenAI and the
 * usage_logs writer are faked. The fake reserve mirrors
 * bbai_reserve_site_generation in 'trial' mode, including its two replay
 * paths (same idempotency key; same fingerprint while reserved/succeeded),
 * so these tests prove a guest cannot get a result without spending a try.
 */
const express = require('express');
const request = require('supertest');

jest.mock('../../lib/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  getRecentEntries: jest.fn().mockReturnValue([]),
  clearRecentEntries: jest.fn()
}));

const callOrder = [];

jest.mock('../../lib/openaiTitles', () => ({
  generateTitleAndMeta: jest.fn(async ({ page }) => {
    callOrder.push('generate');
    if (page?.url === '/fail') {
      const e = new Error('upstream failed');
      e.code = 'UPSTREAM_GENERATION_ERROR';
      e.httpStatus = 502;
      throw e;
    }
    return {
      title: `Title for ${page?.url || 'page'}`,
      meta: `Meta for ${page?.url || 'page'}.`,
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      meta_info: { modelUsed: 'gpt-4o-mini' }
    };
  }),
  buildTitlesPrompt: jest.fn()
}));

jest.mock('../../services/usage', () => ({
  recordUsage: jest.fn().mockResolvedValue({ error: null })
}));

jest.mock('../../services/siteQuota', () => {
  const state = { sites: [], trials: new Map(), requests: [], limit: 10, counter: 0 };

  function resolveSite(identity) {
    // Same order as resolveCanonicalSite for an account-less caller:
    // site_hash first, then the normalised URL (non-development hosts only).
    let site = state.sites.find((s) => identity.siteHash && s.site_hash === identity.siteHash);
    if (!site && !identity.isDevelopment && identity.normalizedSiteUrl) {
      site = state.sites.find((s) => s.normalized_site_url === identity.normalizedSiteUrl);
    }
    if (!site) {
      state.counter += 1;
      site = {
        id: `site-${state.counter}`,
        site_hash: identity.siteHash,
        normalized_site_url: identity.normalizedSiteUrl,
        license_key: null
      };
      state.sites.push(site);
    }
    return site;
  }

  const reserveSiteCredits = jest.fn(async (_supabase, args) => {
    callOrder.push('reserve');
    const site = resolveSite(args.siteIdentity);
    const replay = state.requests.find((r) => (args.idempotencyKey && r.idempotency_key === args.idempotencyKey)
      || (args.requestFingerprint && r.site_id === site.id && r.request_fingerprint === args.requestFingerprint
        && ['reserved', 'succeeded'].includes(r.status)));
    if (replay) {
      return { error: null, site, reservation: { ok: true, duplicate: true, generation_request_id: replay.id, status: replay.status } };
    }
    if (args.quotaMode !== 'trial') {
      const row = { id: `gr-${state.requests.length + 1}`, site_id: site.id, status: 'reserved', quota_source: 'site_quota', idempotency_key: args.idempotencyKey, request_fingerprint: args.requestFingerprint, metadata: args.requestMetadata, credits: args.creditsNeeded };
      state.requests.push(row);
      return { error: null, site, reservation: { ok: true, generation_request_id: row.id, remaining_credits: 40, total_limit: 50, credits_used: 10, plan: 'free' } };
    }
    const trial = state.trials.get(site.id) || { total: state.limit, used: 0 };
    state.trials.set(site.id, trial);
    if (trial.used + args.creditsNeeded > trial.total) {
      return {
        error: 'TRIAL_EXHAUSTED',
        status: 402,
        message: 'Trial quota exhausted',
        payload: { ok: false, code: 'TRIAL_EXHAUSTED', remaining_credits: Math.max(trial.total - trial.used, 0), total_limit: trial.total },
        site
      };
    }
    trial.used += args.creditsNeeded;
    const row = { id: `gr-${state.requests.length + 1}`, site_id: site.id, status: 'reserved', quota_source: 'trial', idempotency_key: args.idempotencyKey, request_fingerprint: args.requestFingerprint, metadata: args.requestMetadata, credits: args.creditsNeeded };
    state.requests.push(row);
    return {
      error: null,
      site,
      reservation: { ok: true, duplicate: false, status: 'reserved', quota_source: 'trial', generation_request_id: row.id, remaining_credits: trial.total - trial.used, total_limit: trial.total, credits_used: trial.used, plan: 'trial' }
    };
  });

  const finalizeSiteGeneration = jest.fn(async (_supabase, { generationRequestId, success }) => {
    const row = state.requests.find((r) => r.id === generationRequestId);
    if (row && row.status === 'reserved') {
      row.status = success ? 'succeeded' : 'released';
      if (!success && row.quota_source === 'trial') {
        const trial = state.trials.get(row.site_id);
        if (trial) trial.used = Math.max(trial.used - row.credits, 0);
      }
    }
    return { data: { status: row?.status || null }, error: null };
  });

  return {
    reserveSiteCredits,
    finalizeSiteGeneration,
    getSiteQuotaStatus: jest.fn(),
    hashRequestFingerprint: (payload) => require('crypto').createHash('sha256').update(JSON.stringify(payload)).digest('hex'),
    __state: state,
    __reset: () => {
      state.sites = [];
      state.trials = new Map();
      state.requests = [];
      state.counter = 0;
      state.limit = 10;
    }
  };
});

const siteQuota = require('../../services/siteQuota');
const { generateTitleAndMeta } = require('../../lib/openaiTitles');
const { recordUsage } = require('../../services/usage');
const { authMiddleware } = require('../../middleware/auth');
const { createTitlesRouter } = require('../../routes/titles');
const { deriveGuestSiteKey } = require('../../services/titlesGuestTrial');

const SITE_URL = 'https://guest-bakery.example.com';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.id = 'req-guest-test'; next(); });
  app.use(authMiddleware({ supabase: null }));
  app.use('/api/titles', createTitlesRouter({
    supabase: { rpc: jest.fn() },
    checkRateLimit: async () => true,
    createJob: jest.fn(async () => 'job-1'),
    getJobRecord: jest.fn(async () => null)
  }));
  return app;
}

function guestPost(app, { trialHash = 'a'.repeat(32), siteUrl = SITE_URL, url = '/about', body = {} } = {}) {
  const req = request(app)
    .post('/api/titles/generate')
    .set('X-Trial-Mode', 'true')
    .set('X-Trial-Site-Hash', trialHash)
    .set('X-Plugin-Version', '1.0.33');
  if (siteUrl) req.set('X-Site-URL', siteUrl);
  return req.send({ page: { url, h1: 'About us', content_excerpt: 'We bake bread.' }, options: {}, trial_mode: true, trial_site_hash: trialHash, ...body });
}

async function useTries(app, count, opts = {}) {
  for (let i = 0; i < count; i += 1) {
    const res = await guestPost(app, { url: `/page-${i}`, ...opts });
    expect(res.status).toBe(200);
  }
}

beforeEach(() => {
  jest.clearAllMocks();
  siteQuota.__reset();
  callOrder.length = 0;
});

describe('POST /api/titles/generate as a guest', () => {
  test('a signed-out site gets a real title and meta from its trial bucket', async () => {
    const app = buildApp();
    const res = await guestPost(app);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      title: 'Title for /about',
      meta: 'Meta for /about.',
      auth_state: 'guest_trial',
      quota_type: 'trial',
      trial_limit: 10,
      trial_used: 1,
      trial_remaining: 9,
      signup_required: false,
      entitlement_state: expect.objectContaining({ is_trial: true, is_logged_in: false })
    });

    const args = siteQuota.reserveSiteCredits.mock.calls[0][1];
    expect(args).toMatchObject({ account: null, licenseKey: null, quotaMode: 'trial', creditsNeeded: 1 });
    expect(args.requestMetadata).toMatchObject({
      guest: true,
      guest_site_key: deriveGuestSiteKey(SITE_URL),
      endpoint: 'api/titles/generate',
      feature_type: 'title_meta',
      auth_state: 'guest_trial'
    });
    // The cap key is derived from the URL, never the plugin's stored id.
    expect(args.siteIdentity.siteHash).toBe(deriveGuestSiteKey(SITE_URL));
    expect(args.siteIdentity.siteHash).not.toBe('a'.repeat(32));

    expect(siteQuota.finalizeSiteGeneration.mock.calls[0][1]).toMatchObject({
      success: true,
      finalMetadata: expect.objectContaining({ guest: true, feature_type: 'title_meta' })
    });

    expect(recordUsage).toHaveBeenCalledTimes(1);
    expect(recordUsage.mock.calls[0][1]).toMatchObject({
      licenseKey: null,
      licenseId: null,
      userEmail: null,
      isTrial: true,
      authState: 'guest_trial',
      creditsUsed: 1,
      endpoint: 'api/titles/generate',
      featureType: 'title_meta',
      siteHash: siteQuota.__state.sites[0].site_hash
    });
  });

  test('the try is reserved before the generator runs', async () => {
    const res = await guestPost(buildApp());
    expect(res.status).toBe(200);
    expect(callOrder).toEqual(['reserve', 'generate']);
  });

  test('after 10 tries the site gets the Alt Text guest-cap 402 and no generation', async () => {
    const app = buildApp();
    await useTries(app, 10);
    generateTitleAndMeta.mockClear();

    const res = await guestPost(app, { url: '/eleventh' });
    expect(res.status).toBe(402);
    expect(res.body).toMatchObject({
      success: false,
      error: 'TRIAL_EXHAUSTED',
      code: 'TRIAL_EXHAUSTED',
      auth_state: 'guest_trial',
      quota_type: 'trial',
      quota_state: 'exhausted',
      credits_total: 10,
      credits_used: 10,
      credits_remaining: 0,
      trial_limit: 10,
      trial_used: 10,
      trial_remaining: 0,
      trial_exhausted: true,
      signup_required: true,
      upgrade_required: false,
      anonymous: expect.objectContaining({ signup_required: true, remaining: 0, total: 10 }),
      entitlement_state: expect.objectContaining({ is_trial: true, is_logged_in: false, can_generate: false }),
      trial_generation: expect.objectContaining({ skipped_due_to_limit: 1, processed_count: 0 })
    });
    expect(generateTitleAndMeta).not.toHaveBeenCalled();
  });

  test('a repeat input on the cap boundary gets the 402 (a replay still counts as a try)', async () => {
    const app = buildApp();
    await useTries(app, 9);

    const tenth = await guestPost(app, { url: '/same-page' });
    expect(tenth.status).toBe(200);
    expect(tenth.body.trial_remaining).toBe(0);

    generateTitleAndMeta.mockClear();
    const repeat = await guestPost(app, { url: '/same-page' });
    expect(repeat.status).toBe(402);
    expect(repeat.body.code).toBe('TRIAL_EXHAUSTED');
    expect(generateTitleAndMeta).not.toHaveBeenCalled();
  });

  test('a repeated input below the cap spends a second try instead of replaying the first', async () => {
    const app = buildApp();
    const first = await guestPost(app, { url: '/same-page' });
    const second = await guestPost(app, { url: '/same-page' });
    expect(first.body.trial_used).toBe(1);
    expect(second.status).toBe(200);
    expect(second.body.trial_used).toBe(2);
    const keys = siteQuota.reserveSiteCredits.mock.calls.map(([, a]) => [a.idempotencyKey, a.requestFingerprint]);
    expect(keys[0][0]).not.toBe(keys[1][0]);
    expect(keys[0][1]).not.toBe(keys[1][1]);
  });

  test('a guest-sent idempotency_key is ignored, so it cannot replay a result for free', async () => {
    const app = buildApp();
    await useTries(app, 9);
    const body = { idempotency_key: 'fixed-key-from-client' };
    expect((await guestPost(app, { url: '/x', body })).status).toBe(200);
    const again = await guestPost(app, { url: '/x', body });
    expect(again.status).toBe(402);
    siteQuota.reserveSiteCredits.mock.calls.forEach(([, a]) => {
      expect(a.idempotencyKey).not.toBe('fixed-key-from-client');
      expect(a.idempotencyKey).toMatch(/^titles-guest:/);
    });
  });

  test('a reinstall (new random plugin site id) on the same URL keeps the used tries', async () => {
    const app = buildApp();
    await useTries(app, 10, { trialHash: 'b'.repeat(32) });

    const variants = [
      { trialHash: 'c'.repeat(32), siteUrl: SITE_URL },
      { trialHash: 'd'.repeat(32), siteUrl: 'http://www.guest-bakery.example.com/' },
      { trialHash: 'e'.repeat(32), siteUrl: 'HTTPS://Guest-Bakery.Example.com:443' }
    ];
    for (const variant of variants) {
      const res = await guestPost(app, { url: '/after-reinstall', ...variant });
      expect(res.status).toBe(402);
    }
    expect(siteQuota.__state.sites).toHaveLength(1);
  });

  test('a development host is capped by the same URL-derived key', async () => {
    const app = buildApp();
    await useTries(app, 10, { siteUrl: 'http://bakery.local', trialHash: 'f'.repeat(32) });
    const res = await guestPost(app, { siteUrl: 'http://bakery.local/', trialHash: '0'.repeat(32), url: '/again' });
    expect(res.status).toBe(402);
  });

  test('another site has its own allowance', async () => {
    const app = buildApp();
    await useTries(app, 10);
    const res = await guestPost(app, { siteUrl: 'https://other-shop.example.com', url: '/x' });
    expect(res.status).toBe(200);
    expect(res.body.trial_used).toBe(1);
  });

  test('a guest generation failure gives the try back', async () => {
    const app = buildApp();
    const failed = await guestPost(app, { url: '/fail' });
    expect(failed.status).toBe(502);
    expect(siteQuota.finalizeSiteGeneration.mock.calls[0][1]).toMatchObject({ success: false });
    const next = await guestPost(app, { url: '/ok' });
    expect(next.body.trial_used).toBe(1);
  });

  test('no site URL means no guest generation and no reservation', async () => {
    const res = await guestPost(buildApp(), { siteUrl: null });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('GUEST_SITE_URL_REQUIRED');
    expect(siteQuota.reserveSiteCredits).not.toHaveBeenCalled();
    expect(generateTitleAndMeta).not.toHaveBeenCalled();
  });

  test('a duplicate reservation is never turned into a free result', async () => {
    siteQuota.reserveSiteCredits.mockImplementationOnce(async () => ({
      error: null,
      site: { id: 'site-x', site_hash: 'tg_x' },
      reservation: { ok: true, duplicate: true, generation_request_id: 'gr-old' }
    }));
    const res = await guestPost(buildApp());
    expect(res.status).toBe(409);
    expect(generateTitleAndMeta).not.toHaveBeenCalled();
  });
});

describe('guest access is limited to the single generate route', () => {
  test('bulk jobs still require an account', async () => {
    const res = await request(buildApp())
      .post('/api/titles/jobs')
      .set('X-Trial-Mode', 'true')
      .set('X-Trial-Site-Hash', 'a'.repeat(32))
      .set('X-Site-URL', SITE_URL)
      .send({ pages: [{ url: '/a' }] });
    expect(res.status).toBe(401);
    expect(siteQuota.reserveSiteCredits).not.toHaveBeenCalled();
  });

  test('quota still requires an account', async () => {
    const res = await request(buildApp())
      .get('/api/titles/quota')
      .set('X-Trial-Mode', 'true')
      .set('X-Trial-Site-Hash', 'a'.repeat(32));
    expect(res.status).toBe(401);
  });

  test('trial headers next to a licence key never open the guest path', async () => {
    const res = await request(buildApp())
      .post('/api/titles/generate')
      .set('X-Trial-Mode', 'true')
      .set('X-Trial-Site-Hash', 'a'.repeat(32))
      .set('X-License-Key', 'some-licence')
      .set('X-Site-URL', SITE_URL)
      .send({ page: { url: '/a' } });
    // Without a database the licence can't be validated, so it is refused;
    // either way no trial reservation happens.
    expect(res.status).not.toBe(200);
    const trialCalls = siteQuota.reserveSiteCredits.mock.calls.filter(([, a]) => a.quotaMode === 'trial');
    expect(trialCalls).toHaveLength(0);
  });
});
