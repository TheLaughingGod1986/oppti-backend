/**
 * /api/jobs/:jobId/cancel and /api/jobs/:jobId/retry — cooperative
 * cancellation and the failed-items retry helper. Same fully-mocked,
 * offline harness as jobs-bulk.test.js (no real Supabase/network calls).
 */
const express = require('express');
const request = require('supertest');

jest.mock('../../middleware/auth', () => ({
  authMiddleware: () => (req, res, next) => {
    req.license = {
      id: '11111111-1111-1111-1111-111111111111',
      license_key: 'test-cancel-license',
      plan: 'pro',
      status: 'active'
    };
    req.authMethod = 'license';
    next();
  },
  extractUserInfo: () => ({ user_id: null, user_email: null, plugin_version: '1.0.0' })
}));

jest.mock('../../services/quota', () => ({
  enforceQuota: jest.fn().mockResolvedValue({ credits_remaining: 1000 }),
  getQuotaStatus: jest.fn().mockResolvedValue({
    error: null,
    plan_type: 'pro',
    credits_used: 5,
    credits_remaining: 995,
    total_limit: 1000
  }),
  reserveGenerationQuota: jest.fn().mockResolvedValue({
    error: null,
    reservation: { generation_request_id: null, quota_source: 'site' },
    site: { id: 'site_1', site_hash: 'cancel-site', license_key: 'test-cancel-license' }
  }),
  finalizeGenerationQuotaReservation: jest.fn().mockResolvedValue({})
}));

// One item fails, and generation is slow enough that a mid-flight /cancel
// call can reliably beat the not-yet-started items to the punch.
jest.mock('../../lib/openai', () => ({
  generateAltText: jest.fn().mockImplementation(async ({ image }) => {
    await new Promise((r) => setTimeout(r, 30));
    if (image?.url === 'https://fail.example/bad.jpg') {
      const e = new Error('simulated provider failure');
      e.code = 'UPSTREAM_GENERATION_ERROR';
      throw e;
    }
    return {
      altText: `alt for ${image?.filename || 'img'}`,
      usage: { total_tokens: 12, prompt_tokens: 10, completion_tokens: 2 },
      meta: { modelUsed: 'gpt-4o-mini', generation_time_ms: 5 }
    };
  })
}));

jest.mock('../../services/usage', () => ({
  recordUsage: jest.fn().mockResolvedValue({ error: null })
}));

jest.mock('../../services/imageAltState', () => ({
  LEDGER_SYNC_SCOPES: { FULL_SITE: 'full_site', PARTIAL: 'partial' },
  resolveImageAltStateSyncTarget: jest.fn().mockResolvedValue({
    site: { id: 'site_1', site_hash: 'cancel-site' },
    matchedBy: 'site_hash',
    error: null
  }),
  syncImageAltStates: jest.fn().mockResolvedValue({
    count: 0, inserted: 0, updated: 0, unchanged: 0, missing_rows_created: 0,
    coverage: { status: 'PARTIAL_LEDGER', snapshot_fallback_active: false },
    errors: []
  }),
  upsertGeneratedImageAltState: jest.fn().mockResolvedValue({ data: {}, error: null })
}));

const { createQueue } = require('../../lib/queue');
const { createBulkAltTextProcessor } = require('../../services/bulkAltTextProcessor');
const { createJobsRouter } = require('../../routes/jobs');

function flushImmediate() {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('POST /api/jobs/:jobId/cancel and /retry', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.BULK_JOB_DISPATCH = 'immediate';

    const queueHolder = { q: null };
    const supabase = {
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: () => Promise.resolve({
              data: { id: '11111111-1111-1111-1111-111111111111' },
              error: null
            })
          })
        })
      })
    };

    const bulkProcessor = createBulkAltTextProcessor({
      supabase,
      getJobRecord: (id) => queueHolder.q.getJobRecord(id),
      setJobRecord: (id, rec) => queueHolder.q.setJobRecord(id, rec),
      itemConcurrency: 1 // serial, so cancellation timing is deterministic
    });

    const queue = createQueue({
      redis: null,
      concurrency: 2,
      ttlSeconds: 3600,
      queueKey: 'test:cancel-queue',
      bulkDispatchMode: 'immediate',
      bulkRunner: (job) => bulkProcessor.run(job),
      jobHandler: async () => {}
    });
    queueHolder.q = queue;

    app = express();
    app.use(express.json());
    app.use('/api/jobs', createJobsRouter({
      supabase,
      checkRateLimit: async () => true,
      getSiteFromHeaders: async () => null,
      createJob: queue.createJob,
      getJobRecord: queue.getJobRecord,
      setJobRecord: queue.setJobRecord
    }));
  });

  test('cancel skips not-yet-started items, leaves in-flight ones to finish', async () => {
    const images = Array.from({ length: 4 }, (_, i) => ({
      id: `att-${i}`,
      image: { url: `https://example.com/${i}.jpg`, width: 100, height: 100, filename: `f${i}.jpg` }
    }));

    const submit = await request(app)
      .post('/api/jobs')
      .set('X-License-Key', 'test-cancel-license')
      .set('X-Site-Key', 'cancel-site')
      .send({ images, context: {} });

    expect(submit.status).toBe(202);
    const jobId = submit.body.jobId;

    // Let the first item start generating (30ms mock delay) before cancelling.
    await flushImmediate();
    await new Promise((r) => setTimeout(r, 10));

    const cancelRes = await request(app).post(`/api/jobs/${jobId}/cancel`);
    expect(cancelRes.status).toBe(200);
    expect(cancelRes.body.message).toMatch(/Cancellation requested/);

    let job;
    for (let i = 0; i < 50; i += 1) {
      await new Promise((r) => setTimeout(r, 20));
      const st = await request(app).get(`/api/jobs/${jobId}`);
      job = st.body;
      if (['completed', 'cancelled'].includes(job.status)) break;
    }

    expect(job.status).toBe('cancelled');
    // The first item was already in flight when cancel landed — it finishes normally.
    expect(job.items[0].status).toBe('completed');
    // Everything after it was still queued and gets skipped outright.
    expect(job.items.slice(1).every((it) => it.status === 'cancelled')).toBe(true);
    expect(job.completed).toBe(1);
  });

  test('cancelling an already-finished job is a no-op', async () => {
    const images = [{ id: 'att-0', image: { url: 'https://example.com/0.jpg', filename: 'f0.jpg' } }];
    const submit = await request(app)
      .post('/api/jobs')
      .set('X-License-Key', 'test-cancel-license')
      .set('X-Site-Key', 'cancel-site')
      .send({ images, context: {} });
    const jobId = submit.body.jobId;

    let job;
    for (let i = 0; i < 50; i += 1) {
      await new Promise((r) => setTimeout(r, 20));
      const st = await request(app).get(`/api/jobs/${jobId}`);
      job = st.body;
      if (job.status === 'completed') break;
    }
    expect(job.status).toBe('completed');

    const cancelRes = await request(app).post(`/api/jobs/${jobId}/cancel`);
    expect(cancelRes.status).toBe(200);
    expect(cancelRes.body.status).toBe('completed'); // unchanged, not flipped to cancelled
  });

  test('retry returns the failed items for the client to resubmit', async () => {
    const images = [
      { id: 'att-ok', image: { url: 'https://example.com/ok.jpg', filename: 'ok.jpg' } },
      { id: 'att-bad', image: { url: 'https://fail.example/bad.jpg', filename: 'bad.jpg' } }
    ];
    const submit = await request(app)
      .post('/api/jobs')
      .set('X-License-Key', 'test-cancel-license')
      .set('X-Site-Key', 'cancel-site')
      .send({ images, context: {} });
    const jobId = submit.body.jobId;

    let job;
    for (let i = 0; i < 50; i += 1) {
      await new Promise((r) => setTimeout(r, 20));
      const st = await request(app).get(`/api/jobs/${jobId}`);
      job = st.body;
      if (job.status === 'completed') break;
    }
    expect(job.status).toBe('completed');
    expect(job.failed).toBe(1);

    const retryRes = await request(app).post(`/api/jobs/${jobId}/retry`);
    expect(retryRes.status).toBe(200);
    expect(retryRes.body.retryable_count).toBe(1);
    expect(retryRes.body.failed_items[0]).toEqual(expect.objectContaining({ id: 'att-bad' }));
  });

  test('retry on a still-running job is rejected', async () => {
    const images = Array.from({ length: 3 }, (_, i) => ({
      id: `att-${i}`,
      image: { url: `https://example.com/${i}.jpg`, filename: `f${i}.jpg` }
    }));
    const submit = await request(app)
      .post('/api/jobs')
      .set('X-License-Key', 'test-cancel-license')
      .set('X-Site-Key', 'cancel-site')
      .send({ images, context: {} });
    const jobId = submit.body.jobId;

    // Assert while still running (the 30ms-per-item mock delay guarantees
    // that), then drain the job so no async work logs after the test ends.
    const retryRes = await request(app).post(`/api/jobs/${jobId}/retry`);
    expect(retryRes.status).toBe(409);
    expect(retryRes.body.error).toBe('JOB_STILL_RUNNING');

    for (let i = 0; i < 50; i += 1) {
      const st = await request(app).get(`/api/jobs/${jobId}`);
      if (['completed', 'cancelled', 'failed'].includes(st.body.status)) break;
      await new Promise((r) => setTimeout(r, 20));
    }
  });
});
