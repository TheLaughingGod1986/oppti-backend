process.env.ALT_TEXT_IDEMPOTENCY_WAIT_MS = '400';
process.env.ALT_TEXT_IDEMPOTENCY_POLL_MS = '20';

const express = require('express');
const request = require('supertest');
const { authMiddleware } = require('../../middleware/auth');
const { generateAltText } = require('../../lib/openai');

jest.mock('../../lib/openai', () => ({ generateAltText: jest.fn() }));

// Quota sim mirroring bbai_reserve/finalize_site_generation as on main: a
// same-key duplicate that is still 'reserved' is NOT treated as succeeded, so
// without the claim both concurrent requests would be charged.
const mockDb = { gen: [], usage_logs: [], site_used: 0, claims: new Map() };
jest.mock('../../services/quota', () => ({
  getQuotaStatus: jest.fn(async () => ({ plan_type: 'pro', credits_used: 0, credits_remaining: 1000, total_limit: 1000 })),
  reserveGenerationQuota: jest.fn(async (_s, { idempotencyKey }) => {
    const site = { id: 'site_1', site_hash: 'site-key-1', license_key: 'key-123' };
    const ex = idempotencyKey && mockDb.gen.find((g) => g.key === idempotencyKey);
    if (ex) return { error: null, reservation: { ok: true, duplicate: true, status: ex.status, generation_request_id: ex.id, quota_source: 'site_quota' }, site };
    const g = { id: `gr_${mockDb.gen.length + 1}`, key: idempotencyKey, status: 'reserved' };
    mockDb.gen.push(g); mockDb.site_used += 1;
    return { error: null, reservation: { ok: true, duplicate: false, status: 'reserved', generation_request_id: g.id, quota_source: 'site_quota' }, site };
  }),
  finalizeGenerationQuotaReservation: jest.fn(async (_s, { generationRequestId, success }) => {
    const g = mockDb.gen.find((x) => x.id === generationRequestId);
    if (g.status !== 'reserved') return { error: null, data: { status: g.status } };
    g.status = success ? 'succeeded' : 'released'; if (!success) mockDb.site_used -= 1;
    return { error: null, data: { status: g.status } };
  })
}));
jest.mock('../../services/usage', () => ({
  recordUsage: jest.fn(async (_s, row) => { mockDb.usage_logs.push(row); return { error: null, data: { id: `u${mockDb.usage_logs.length}` } }; })
}));
jest.mock('../../services/imageAltState', () => ({ upsertGeneratedImageAltState: jest.fn().mockResolvedValue({ data: { id: 's' }, error: null }) }));
const { createAltTextRouter } = require('../../routes/altText');

const lic = { id: '11111111-1111-1111-1111-111111111111', license_key: 'key-123', plan: 'pro', status: 'active' };

// In-memory table with a real PRIMARY KEY (scope, idempotency_key).
function claimsTable() {
  const f = {}; let op = null; let payload = null; let wantRows = false;
  const id = () => `${f.scope}|${f.idempotency_key}`;
  const run = () => {
    if (op === 'insert') {
      const k = `${payload.scope}|${payload.idempotency_key}`;
      if (mockDb.claims.has(k)) return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint' } };
      mockDb.claims.set(k, { ...payload }); return { data: null, error: null };
    }
    const row = mockDb.claims.get(id());
    const match = row && Object.entries(f).every(([c, v]) => row[c] === v);
    if (op === 'select') return { data: match ? { ...row } : null, error: null };
    if (op === 'update') { if (match) Object.assign(row, payload); return { data: wantRows ? (match ? [row] : []) : null, error: null }; }
    if (op === 'delete') { if (match) mockDb.claims.delete(id()); return { data: null, error: null }; }
    return { data: null, error: null };
  };
  const c = {
    insert: (p) => { op = 'insert'; payload = p; return c; },
    update: (p) => { op = 'update'; payload = p; return c; },
    delete: () => { op = 'delete'; return c; },
    select: () => { if (!op) op = 'select'; else wantRows = true; return c; },
    eq: (col, v) => { f[col] = v; return c; },
    maybeSingle: () => Promise.resolve(run()),
    then: (r, j) => Promise.resolve(run()).then(r, j)
  };
  return c;
}

function sb() {
  const c = { select: () => c, eq: () => c, neq: () => c, gt: () => c, gte: () => c, lt: () => c, lte: () => c, like: () => c, ilike: () => c, is: () => c, in: () => c, or: () => c, order: () => c, limit: () => c, insert: () => c, update: () => c, upsert: () => c, delete: () => c,
    single: () => Promise.resolve({ data: lic, error: null }), maybeSingle: () => Promise.resolve({ data: lic, error: null }), then: (r, j) => Promise.resolve({ data: [lic], error: null }).then(r, j) };
  return { from: (t) => (t === 'generation_idempotency_claims' ? claimsTable() : c) };
}
const ok = { altText: 'stub alt', usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }, meta: { modelUsed: 'stub', generation_time_ms: 1 } };
function app() {
  const s = sb(); const a = express(); a.use(express.json()); a.use(authMiddleware({ supabase: s }));
  a.use('/api/alt-text', createAltTextRouter({ supabase: s, redis: null, resultCache: new Map(), checkRateLimit: async () => true, getSiteFromHeaders: async () => ({ quota: 50, used: 0, remaining: 50 }) }));
  return a;
}
const post = (a, key, img) => request(a).post('/api/alt-text').set('X-License-Key', 'key-123').set('Idempotency-Key', key).send({ image: { url: `https://example.com/${img}.jpg`, width: 1, height: 1 } });
const charges = () => mockDb.usage_logs.filter((r) => !r.isTrial && !r.is_trial).length;
const delayed = (value, ms) => new Promise((resolve) => setTimeout(() => resolve(value), ms));

beforeEach(() => {
  mockDb.gen = []; mockDb.usage_logs = []; mockDb.site_used = 0; mockDb.claims.clear();
  generateAltText.mockReset();
});

describe('Idempotency-Key is claimed before the credit hold', () => {
  test('two concurrent same-key requests: one generation, one charge, both get the alt text', async () => {
    const a = app();
    generateAltText.mockImplementation(() => delayed(ok, 120));
    const [x, y] = await Promise.all([post(a, 'con-k', 'c1'), post(a, 'con-k', 'c1')]);
    expect(x.status).toBe(200);
    expect(y.status).toBe(200);
    expect(x.body.altText).toBe('stub alt');
    expect(y.body.altText).toBe('stub alt');
    expect([x.body.idempotent_replay, y.body.idempotent_replay].filter(Boolean)).toHaveLength(1);
    expect(generateAltText).toHaveBeenCalledTimes(1);
    expect(charges()).toBe(1);
    expect(mockDb.site_used).toBe(1);
  });

  test('five concurrent same-key requests still charge once', async () => {
    const a = app();
    generateAltText.mockImplementation(() => delayed(ok, 80));
    const rs = await Promise.all([1, 2, 3, 4, 5].map(() => post(a, 'burst-k', 'b')));
    rs.forEach((r) => expect(r.status).toBe(200));
    expect(generateAltText).toHaveBeenCalledTimes(1);
    expect(charges()).toBe(1);
  });

  test('second request gets 409 IDEMPOTENCY_IN_PROGRESS when the first outlasts the wait', async () => {
    const a = app();
    generateAltText.mockImplementation(() => delayed(ok, 900));
    const first = post(a, 'slow-k', 's').then((r) => r);
    await delayed(null, 50);
    const second = await post(a, 'slow-k', 's');
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('IDEMPOTENCY_IN_PROGRESS');
    expect(second.body.retryable).toBe(true);
    expect(second.headers['retry-after']).toBe('2');
    expect((await first).status).toBe(200);
    expect(charges()).toBe(1);
  });

  test('sequential same-key retry after success replays without charging', async () => {
    const a = app();
    generateAltText.mockResolvedValue(ok);
    const r1 = await post(a, 'seq-k', 's1');
    const r2 = await post(a, 'seq-k', 's1');
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r2.body.idempotent_replay).toBe(true);
    expect(r2.headers['idempotent-replayed']).toBe('true');
    expect(generateAltText).toHaveBeenCalledTimes(1);
    expect(charges()).toBe(1);
  });

  test('a failed first run releases the claim, so the waiting request generates itself', async () => {
    const a = app();
    generateAltText
      .mockImplementationOnce(() => delayed(null, 60).then(() => { throw Object.assign(new Error('boom'), { code: 'UPSTREAM_GENERATION_ERROR' }); }))
      .mockImplementation(() => delayed(ok, 10));
    const [x, y] = await Promise.all([post(a, 'fail-k', 'f'), post(a, 'fail-k', 'f')]);
    const statuses = [x.status, y.status].sort();
    expect(statuses).toEqual([200, 502]);
    expect(charges()).toBe(1);
    expect(mockDb.claims.get('site-key-1|fail-k')).toBeUndefined();
  });

  test('different keys are independent', async () => {
    const a = app();
    generateAltText.mockImplementation(() => delayed(ok, 30));
    const [x, y] = await Promise.all([post(a, 'k-1', 'i1'), post(a, 'k-2', 'i2')]);
    expect([x.status, y.status]).toEqual([200, 200]);
    expect(charges()).toBe(2);
  });
});
