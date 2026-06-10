/**
 * Bulk /api/titles/jobs pipeline: end-to-end with mocked OpenAI + title quota.
 */
const express = require('express');
const request = require('supertest');

jest.mock('../../middleware/auth', () => ({
  authMiddleware: () => (req, _res, next) => {
    req.license = {
      id: '11111111-1111-1111-1111-111111111111',
      license_key: 'test-titles-bulk',
      plan: 'pro',
      status: 'active'
    };
    req.authMethod = 'license';
    next();
  },
  extractUserInfo: () => ({ user_id: null, user_email: null, plugin_version: '1.0.0' })
}));

jest.mock('../../lib/openaiTitles', () => ({
  generateTitleAndMeta: jest.fn(async ({ page }) => {
    if (page?.url === '/fail') {
      const e = new Error('upstream failed');
      e.code = 'UPSTREAM_GENERATION_ERROR';
      throw e;
    }
    return {
      title: `Title for ${page?.url || 'page'}`,
      meta: `Meta description for ${page?.url || 'page'}.`,
      usage: { total_tokens: 100, prompt_tokens: 80, completion_tokens: 20 },
      meta_info: { modelUsed: 'gpt-4o-mini', regenerated: false, latencyMs: 4 }
    };
  }),
  buildTitlesPrompt: jest.fn()
}));

jest.mock('../../services/titleQuota', () => ({
  TITLES_FEATURE_TYPE: 'title_meta',
  reserveTitleGenerationQuota: jest.fn(async () => ({
    error: null,
    site: { id: 'site-1', site_hash: 'site-hash', license_key: 'test-titles-bulk' },
    reservation: { generation_request_id: 'gen-bulk', remaining_credits: 99, total_limit: 100 }
  })),
  finalizeTitleGenerationQuota: jest.fn(async () => ({ data: { status: 'succeeded' }, error: null })),
  getTitleQuotaStatus: jest.fn(async () => ({
    feature_type: 'title_meta',
    credits_remaining: 100,
    total_limit: 100,
    credits_used: 0,
    daily_remaining: 200,
    daily_limit: 200,
    source: 'site_title_quotas'
  })),
  buildTitleRequestFingerprint: jest.fn(() => 'fp-bulk')
}));

jest.mock('../../services/usage', () => ({
  recordUsage: jest.fn().mockResolvedValue({ error: null })
}));

const { createTitlesRouter } = require('../../routes/titles');
const { createQueue } = require('../../lib/queue');
const { createBulkTitlesProcessor } = require('../../services/bulkTitlesProcessor');

function flushImmediate() {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('POST /api/titles/jobs bulk pipeline', () => {
  let app;
  let queue;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.BULK_JOB_DISPATCH = 'immediate';

    const queueHolder = { q: null };
    const supabase = {};
    const processor = createBulkTitlesProcessor({
      supabase,
      getJobRecord: (id) => queueHolder.q.getJobRecord(id),
      setJobRecord: (id, rec) => queueHolder.q.setJobRecord(id, rec),
      itemConcurrency: 2
    });

    queue = createQueue({
      redis: null,
      concurrency: 1,
      ttlSeconds: 60,
      bulkRunner: (job) => processor.run(job),
      jobHandler: async (job) => processor.run(job)
    });
    queueHolder.q = queue;

    app = express();
    app.use(express.json({ limit: '4mb' }));
    app.use((req, _res, next) => { req.id = 'req-bulk'; next(); });
    app.use('/api/titles', createTitlesRouter({
      supabase,
      checkRateLimit: async () => true,
      createJob: queue.createJob,
      getJobRecord: queue.getJobRecord
    }));
  });

  test('creates a bulk_titles job and processes pages successfully', async () => {
    const submit = await request(app)
      .post('/api/titles/jobs')
      .set('X-License-Key', 'test-titles-bulk')
      .set('X-Site-Hash', 'site-hash')
      .set('X-Site-URL', 'https://example.test')
      .send({
        pages: [
          { url: '/a', h1: 'A' },
          { url: '/b', h1: 'B' }
        ],
        options: { brand_name: 'X' }
      });

    expect(submit.status).toBe(202);
    expect(submit.body.success).toBe(true);
    expect(submit.body.jobId).toBeTruthy();
    const { jobId } = submit.body;

    // Allow setImmediate-dispatched work to finish.
    for (let i = 0; i < 10; i += 1) await flushImmediate();
    await new Promise((r) => setTimeout(r, 30));

    const poll = await request(app)
      .get(`/api/titles/jobs/${jobId}`)
      .set('X-Site-Hash', 'site-hash')
      .set('X-Site-URL', 'https://example.test');

    expect(poll.status).toBe(200);
    expect(poll.body.type).toBe('bulk_titles');
    expect(poll.body.total).toBe(2);
    expect(poll.body.completed).toBe(2);
    expect(poll.body.failed).toBe(0);
    expect(poll.body.items[0].title).toBe('Title for /a');
    expect(poll.body.items[1].meta).toContain('Meta description');
  });

  test('records failed items without aborting the rest of the batch', async () => {
    const submit = await request(app)
      .post('/api/titles/jobs')
      .set('X-License-Key', 'test-titles-bulk')
      .set('X-Site-Hash', 'site-hash')
      .set('X-Site-URL', 'https://example.test')
      .send({
        pages: [
          { url: '/ok-1', h1: 'OK 1' },
          { url: '/fail', h1: 'Fail' },
          { url: '/ok-2', h1: 'OK 2' }
        ]
      });
    expect(submit.status).toBe(202);
    const { jobId } = submit.body;

    for (let i = 0; i < 15; i += 1) await flushImmediate();
    await new Promise((r) => setTimeout(r, 50));

    const poll = await request(app)
      .get(`/api/titles/jobs/${jobId}`)
      .set('X-Site-Hash', 'site-hash')
      .set('X-Site-URL', 'https://example.test');

    expect(poll.status).toBe(200);
    expect(poll.body.total).toBe(3);
    expect(poll.body.completed).toBe(2);
    expect(poll.body.failed).toBe(1);
    const failedItem = poll.body.items.find((it) => it.success === false);
    expect(failedItem.errorCode).toBe('UPSTREAM_GENERATION_ERROR');
  });

  test('returns 400 for empty pages array', async () => {
    const res = await request(app)
      .post('/api/titles/jobs')
      .set('X-License-Key', 'test-titles-bulk')
      .set('X-Site-Hash', 'site-hash')
      .set('X-Site-URL', 'https://example.test')
      .send({ pages: [] });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_REQUEST');
  });
});
