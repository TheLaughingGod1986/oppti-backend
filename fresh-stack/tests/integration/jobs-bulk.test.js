/**
 * Bulk /api/jobs pipeline: real generation path with mocks for OpenAI + quota.
 */
const express = require('express');
const request = require('supertest');

jest.mock('../../middleware/auth', () => ({
  authMiddleware: () => (req, res, next) => {
    req.license = {
      id: '11111111-1111-1111-1111-111111111111',
      license_key: 'test-bulk-license',
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
    site: { id: 'site_1', site_hash: 'bulk-site', license_key: 'test-bulk-license' }
  }),
  finalizeGenerationQuotaReservation: jest.fn().mockResolvedValue({})
}));

jest.mock('../../lib/openai', () => ({
  generateAltText: jest.fn().mockImplementation(async ({ image }) => {
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
  LEDGER_SYNC_SCOPES: {
    FULL_SITE: 'full_site',
    PARTIAL: 'partial'
  },
  resolveImageAltStateSyncTarget: jest.fn().mockResolvedValue({
    site: {
      id: 'site_1',
      site_hash: 'bulk-site'
    },
    matchedBy: 'site_hash',
    error: null
  }),
  syncImageAltStates: jest.fn().mockResolvedValue({
    count: 5,
    inserted: 5,
    updated: 0,
    unchanged: 0,
    missing_rows_created: 5,
    coverage: {
      status: 'PARTIAL_LEDGER',
      snapshot_fallback_active: false
    },
    errors: []
  }),
  upsertGeneratedImageAltState: jest.fn().mockResolvedValue({
    data: { id: 'image_state_1', current_state: 'NEEDS_REVIEW' },
    error: null
  })
}));

const { createQueue } = require('../../lib/queue');
const { createBulkAltTextProcessor } = require('../../services/bulkAltTextProcessor');
const { createJobsRouter } = require('../../routes/jobs');
const imageAltStateService = require('../../services/imageAltState');
const usageService = require('../../services/usage');

function flushImmediate() {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('POST /api/jobs bulk pipeline', () => {
  let app;
  let queue;
  let quota;

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
      itemConcurrency: 3
    });

    queue = createQueue({
      redis: null,
      concurrency: 2,
      ttlSeconds: 3600,
      queueKey: 'test:queue',
      bulkDispatchMode: 'immediate',
      bulkRunner: (job) => bulkProcessor.run(job),
      jobHandler: async () => {}
    });
    queueHolder.q = queue;

    quota = require('../../services/quota');

    app = express();
    app.use(express.json());
    app.use('/api/jobs', createJobsRouter({
      supabase,
      checkRateLimit: async () => true,
      getSiteFromHeaders: async () => null,
      createJob: queue.createJob,
      getJobRecord: queue.getJobRecord
    }));
  });

  test('accepts job quickly and completes 5 images with per-item state', async () => {
    const images = Array.from({ length: 5 }, (_, i) => ({
      id: `att-${i}`,
      image: {
        url: `https://example.com/${i}.jpg`,
        width: 100,
        height: 100,
        filename: `f${i}.jpg`
      }
    }));

    const acceptStart = Date.now();
    const res = await request(app)
      .post('/api/jobs')
      .set('X-License-Key', 'test-bulk-license')
      .set('X-Site-Key', 'bulk-site')
      .send({ images, context: { pageTitle: 'Gallery' } });

    expect(res.status).toBe(202);
    expect(res.body.jobId).toBeTruthy();
    expect(res.body.total).toBe(5);
    const acceptMs = Date.now() - acceptStart;
    expect(acceptMs).toBeLessThan(5000);

    await flushImmediate();
    await flushImmediate();

    let job;
    for (let i = 0; i < 50; i += 1) {
      await new Promise((r) => setTimeout(r, 20));
      const st = await request(app).get(`/api/jobs/${res.body.jobId}`);
      job = st.body;
      if (job.status === 'completed') break;
    }

    expect(job.status).toBe('completed');
    expect(job.completed).toBe(5);
    expect(job.failed).toBe(0);
    expect(job.items.every((it) => it.status === 'completed')).toBe(true);
    expect(job.results).toHaveLength(5);
    expect(job.entitlement_state).toEqual(expect.objectContaining({
      plan: 'pro',
      tokens_remaining: 995,
      can_generate: true
    }));
    expect(quota.enforceQuota).toHaveBeenCalled();
    expect(imageAltStateService.upsertGeneratedImageAltState).toHaveBeenCalledTimes(5);
    expect(usageService.recordUsage).toHaveBeenCalled();
    // Identity cleanup: licenses.id is persisted in license_id, never user_id.
    expect(usageService.recordUsage).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      licenseId: '11111111-1111-1111-1111-111111111111',
      userId: null,
      endpoint: 'api/jobs/bulk',
      status: 'success'
    }));
    expect(imageAltStateService.resolveImageAltStateSyncTarget).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      siteHash: 'bulk-site',
      licenseKey: 'test-bulk-license'
    }));
    expect(imageAltStateService.syncImageAltStates).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      siteId: 'site_1',
      siteHash: 'bulk-site',
      images,
      scope: 'partial',
      allowDowngrade: false
    }));
  });

  test('isolates a single failing image in a mixed batch', async () => {
    const images = [
      {
        id: 'a',
        image: { url: 'https://example.com/ok.jpg', width: 10, height: 10, filename: 'ok.jpg' }
      },
      {
        id: 'b',
        image: { url: 'https://fail.example/bad.jpg', width: 10, height: 10, filename: 'bad.jpg' }
      },
      {
        id: 'c',
        image: { url: 'https://example.com/ok2.jpg', width: 10, height: 10, filename: 'ok2.jpg' }
      }
    ];

    const res = await request(app)
      .post('/api/jobs')
      .set('X-License-Key', 'test-bulk-license')
      .set('X-Site-Key', 'bulk-site')
      .send({ images });

    expect(res.status).toBe(202);
    await flushImmediate();
    await flushImmediate();

    let job;
    for (let i = 0; i < 80; i += 1) {
      await new Promise((r) => setTimeout(r, 25));
      const st = await request(app).get(`/api/jobs/${res.body.jobId}`);
      job = st.body;
      if (job.status === 'completed') break;
    }

    expect(job.completed).toBe(2);
    expect(job.failed).toBe(1);
    const failed = job.items.find((it) => it.id === 'b');
    expect(failed.status).toBe('failed');
  });

  test('returns 402 when batch quota gate fails', async () => {
    quota.enforceQuota.mockRejectedValueOnce(
      Object.assign(new Error('quota'), {
        status: 402,
        code: 'QUOTA_EXCEEDED',
        payload: { credits_remaining: 0 }
      })
    );
    quota.getQuotaStatus.mockResolvedValueOnce({
      error: null,
      plan_type: 'pro',
      credits_used: 1000,
      credits_remaining: 0,
      total_limit: 1000
    });

    const res = await request(app)
      .post('/api/jobs')
      .set('X-License-Key', 'test-bulk-license')
      .set('X-Site-Key', 'bulk-site')
      .send({
        images: [
          { image: { url: 'https://example.com/1.jpg', width: 1, height: 1 } }
        ]
      });

    expect(res.status).toBe(402);
    expect(res.body.entitlement_state).toEqual(expect.objectContaining({
      plan: 'pro',
      can_generate: false
    }));
  });

  test('returns daily exhaustion when a free batch exceeds today remaining allowance', async () => {
    quota.enforceQuota.mockRejectedValueOnce(
      Object.assign(new Error('Daily free generation limit reached'), {
        status: 402,
        code: 'DAILY_QUOTA_EXCEEDED',
        payload: {
          credits_remaining: 47,
          daily_generation_limit: 5,
          daily_generations_used: 3,
          daily_generations_remaining: 2,
          daily_reset_date: '2026-05-27T00:00:00.000Z'
        }
      })
    );
    quota.getQuotaStatus.mockResolvedValueOnce({
      error: null,
      plan_type: 'free',
      credits_used: 3,
      credits_remaining: 47,
      total_limit: 50,
      daily_generation_limit: 5,
      daily_generations_used: 3,
      daily_generations_remaining: 2,
      daily_reset_date: '2026-05-27T00:00:00.000Z'
    });

    const res = await request(app)
      .post('/api/jobs')
      .set('X-License-Key', 'test-bulk-license')
      .set('X-Site-Key', 'bulk-site')
      .send({
        images: [
          { image: { url: 'https://example.com/1.jpg', width: 1, height: 1 } },
          { image: { url: 'https://example.com/2.jpg', width: 1, height: 1 } },
          { image: { url: 'https://example.com/3.jpg', width: 1, height: 1 } }
        ]
      });

    expect(res.status).toBe(402);
    expect(res.body.code).toBe('DAILY_QUOTA_EXCEEDED');
    expect(res.body.entitlement_state).toEqual(expect.objectContaining({
      plan: 'free',
      tokens_remaining: 47,
      daily_generations_remaining: 2,
      can_generate: true,
      can_autopilot: false
    }));
  });

  test('returns 401 without license key', async () => {
    const res = await request(app)
      .post('/api/jobs')
      .set('X-Site-Key', 'bulk-site')
      .send({
        images: [
          { image: { url: 'https://example.com/1.jpg', width: 1, height: 1 } }
        ]
      });

    expect(res.status).toBe(401);
  });

  test('uses explicit full-site scope when the product flow declares complete inventory', async () => {
    const images = [
      {
        id: 'a',
        image: { url: 'https://example.com/a.jpg', width: 10, height: 10, filename: 'a.jpg' }
      },
      {
        id: 'b',
        image: { url: 'https://example.com/b.jpg', width: 10, height: 10, filename: 'b.jpg' }
      }
    ];

    await request(app)
      .post('/api/jobs')
      .set('X-License-Key', 'test-bulk-license')
      .set('X-Site-Key', 'bulk-site')
      .send({
        images,
        context: {
          inventory_scope: 'full_site'
        }
      });

    await flushImmediate();
    await flushImmediate();

    expect(imageAltStateService.syncImageAltStates).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      siteId: 'site_1',
      images,
      scope: 'full_site'
    }));
  });
});
