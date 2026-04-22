const express = require('express');
const request = require('supertest');

jest.mock('../../services/quota', () => ({
  getQuotaStatus: jest.fn()
}));

const { getQuotaStatus } = require('../../services/quota');
const { createDashboardRouter } = require('../../routes/dashboard');

function buildQuery(rows, error = null) {
  const state = { rows: Array.isArray(rows) ? rows.slice() : [] };
  let countMode = false;

  const chain = {
    select(_columns, options = {}) {
      countMode = Boolean(options?.head && options?.count === 'exact');
      return chain;
    },
    eq(column, value) {
      state.rows = state.rows.filter((row) => row?.[column] === value);
      return chain;
    },
    in(column, values) {
      state.rows = state.rows.filter((row) => Array.isArray(values) && values.includes(row?.[column]));
      return chain;
    },
    order(column, options = {}) {
      const ascending = options.ascending !== false;
      state.rows = state.rows.slice().sort((left, right) => {
        const leftValue = left?.[column];
        const rightValue = right?.[column];
        if (leftValue === rightValue) return 0;
        if (leftValue === undefined || leftValue === null) return 1;
        if (rightValue === undefined || rightValue === null) return -1;
        return ascending
          ? (leftValue > rightValue ? 1 : -1)
          : (leftValue < rightValue ? 1 : -1);
      });
      return chain;
    },
    limit(count) {
      state.rows = state.rows.slice(0, count);
      return chain;
    },
    then(resolve, reject) {
      return Promise.resolve(
        countMode
          ? { count: error ? 0 : state.rows.length, error }
          : { data: error ? null : state.rows, error }
      ).then(resolve, reject);
    }
  };

  return chain;
}

function createSupabaseMock({
  imageAltStates = [],
  auditLogs = [],
  generationRequests = []
} = {}) {
  return {
    from(table) {
      if (table === 'image_alt_states') {
        return {
          select(columns, options = {}) {
            return buildQuery(imageAltStates).select(columns, options);
          }
        };
      }

      if (table === 'site_audit_logs') {
        return {
          select() {
            return buildQuery(auditLogs);
          }
        };
      }

      if (table === 'generation_requests') {
        return {
          select() {
            return buildQuery(generationRequests);
          }
        };
      }

      throw new Error(`Unexpected table ${table}`);
    }
  };
}

function buildImageAltStates({
  missing = 0,
  generated = 0,
  needsReview = 0,
  approved = 0
} = {}) {
  const rows = [];

  function pushRows(count, state) {
    for (let index = 0; index < count; index += 1) {
      rows.push({
        id: `${state.toLowerCase()}-${index + 1}`,
        site_id: 'site-1',
        image_ref: `${state.toLowerCase()}-${index + 1}`,
        current_state: state
      });
    }
  }

  pushRows(missing, 'MISSING');
  pushRows(generated, 'GENERATED');
  pushRows(needsReview, 'NEEDS_REVIEW');
  pushRows(approved, 'APPROVED');

  return rows;
}

function createApp({
  supabase,
  getJobRecord = async () => null,
  license = {
    id: 'license-1',
    license_key: 'license-key-1',
    plan: 'free',
    status: 'active'
  }
}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.license = license;
    req.user = license;
    req.authMethod = 'license';
    req.id = 'req-dashboard-truth';
    next();
  });
  app.use('/dashboard', createDashboardRouter({ supabase, getJobRecord }));
  return app;
}

function mockQuotaStatus(overrides = {}) {
  getQuotaStatus.mockResolvedValue({
    error: null,
    site: {
      id: 'site-1',
      site_hash: 'site-hash-1'
    },
    plan_type: 'free',
    credits_used: 10,
    credits_remaining: 40,
    total_limit: 50,
    reset_date: '2026-05-01T00:00:00.000Z',
    ...overrides
  });
}

describe('GET /dashboard/state-truth', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('returns MISSING_ALT when authoritative counts show missing images and no active job', async () => {
    mockQuotaStatus();
    const app = createApp({
      supabase: createSupabaseMock({
        imageAltStates: buildImageAltStates({ missing: 3, approved: 5 })
      })
    });

    const res = await request(app).get('/dashboard/state-truth').set('X-Site-Key', 'site-hash-1');

    expect(res.status).toBe(200);
    expect(res.body.state).toBe('MISSING_ALT');
    expect(res.body.counts).toEqual({
      missing: 3,
      to_review: 0,
      optimized: 5,
      total_attention: 3
    });
    expect(res.body.job.status).toBe('IDLE');
    expect(res.body.resolution.count_source).toBe('image_alt_states');
  });

  test('uses site_audit_logs as a temporary fallback when a site has no ledger rows yet', async () => {
    mockQuotaStatus();
    const app = createApp({
      supabase: createSupabaseMock({
        auditLogs: [
          {
            site_id: 'site-1',
            event_type: 'media_scan_completed',
            created_at: '2026-04-21T10:00:00.000Z',
            metadata: {
              counts: {
                missing: 2,
                to_review: 1,
                optimized: 7
              }
            }
          }
        ]
      })
    });

    const res = await request(app).get('/dashboard/state-truth').set('X-Site-Key', 'site-hash-1');

    expect(res.status).toBe(200);
    expect(res.body.state).toBe('NEEDS_REVIEW');
    expect(res.body.counts).toEqual({
      missing: 2,
      to_review: 1,
      optimized: 7,
      total_attention: 3
    });
    expect(res.body.resolution.count_source).toBe('site_audit_logs:media_scan_completed');
  });

  test('returns QUEUED when the referenced bulk job is queued', async () => {
    mockQuotaStatus();
    const getJobRecord = jest.fn().mockResolvedValue({
      jobId: 'job-queued',
      status: 'accepted',
      total: 10,
      completed: 0,
      failed: 0,
      updatedAt: new Date().toISOString(),
      items: Array.from({ length: 10 }, (_, index) => ({
        id: `item-${index}`,
        status: 'queued',
        stage: 'queued'
      }))
    });
    const app = createApp({
      supabase: createSupabaseMock({
        imageAltStates: buildImageAltStates({ approved: 1 })
      }),
      getJobRecord
    });

    const res = await request(app)
      .get('/dashboard/state-truth?job_id=job-queued')
      .set('X-Site-Key', 'site-hash-1');

    expect(res.status).toBe(200);
    expect(res.body.state).toBe('QUEUED');
    expect(res.body.job.status).toBe('QUEUED');
    expect(res.body.job.active).toBe(true);
    expect(res.body.job.queue_count).toBe(10);
    expect(res.body.resolution.job_source).toBe('job_record');
  });

  test('returns PROCESSING when the referenced bulk job is actively processing', async () => {
    mockQuotaStatus();
    const getJobRecord = jest.fn().mockResolvedValue({
      jobId: 'job-processing',
      status: 'processing',
      total: 6,
      completed: 2,
      failed: 1,
      updatedAt: new Date().toISOString(),
      items: [
        { id: 'a', status: 'completed', stage: 'completed' },
        { id: 'b', status: 'completed', stage: 'completed' },
        { id: 'c', status: 'failed', stage: 'failed' },
        { id: 'd', status: 'generating', stage: 'generating' },
        { id: 'e', status: 'queued', stage: 'queued' },
        { id: 'f', status: 'queued', stage: 'queued' }
      ]
    });
    const app = createApp({
      supabase: createSupabaseMock({
        imageAltStates: buildImageAltStates({ approved: 1 })
      }),
      getJobRecord
    });

    const res = await request(app)
      .get('/dashboard/state-truth?job_id=job-processing')
      .set('X-Site-Key', 'site-hash-1');

    expect(res.status).toBe(200);
    expect(res.body.state).toBe('PROCESSING');
    expect(res.body.job.status).toBe('PROCESSING');
    expect(res.body.job.active).toBe(true);
    expect(res.body.job.progress_done).toBe(3);
    expect(res.body.job.progress_total).toBe(6);
  });

  test('returns NEEDS_REVIEW when review counts are present and no active job exists', async () => {
    mockQuotaStatus();
    const app = createApp({
      supabase: createSupabaseMock({
        imageAltStates: buildImageAltStates({ needsReview: 2, approved: 8 })
      })
    });

    const res = await request(app).get('/dashboard/state-truth').set('X-Site-Key', 'site-hash-1');

    expect(res.status).toBe(200);
    expect(res.body.state).toBe('NEEDS_REVIEW');
    expect(res.body.counts.to_review).toBe(2);
    expect(res.body.counts.total_attention).toBe(2);
  });

  test('returns ALL_CLEAR when authoritative counts show no missing or review work', async () => {
    mockQuotaStatus();
    const app = createApp({
      supabase: createSupabaseMock({
        imageAltStates: buildImageAltStates({ approved: 12 })
      })
    });

    const res = await request(app).get('/dashboard/state-truth').set('X-Site-Key', 'site-hash-1');

    expect(res.status).toBe(200);
    expect(res.body.state).toBe('ALL_CLEAR');
    expect(res.body.counts.optimized).toBe(12);
    expect(res.body.resolution.state_source).toBe('counts.clear');
  });

  test('returns QUOTA_EXHAUSTED before any job or count state when credits are exhausted', async () => {
    mockQuotaStatus({
      credits_used: 50,
      credits_remaining: 0,
      total_limit: 50
    });
    const app = createApp({
      supabase: createSupabaseMock({
        imageAltStates: buildImageAltStates({ missing: 5, needsReview: 4, approved: 1 })
      })
    });

    const res = await request(app).get('/dashboard/state-truth').set('X-Site-Key', 'site-hash-1');

    expect(res.status).toBe(200);
    expect(res.body.state).toBe('QUOTA_EXHAUSTED');
    expect(res.body.credits.exhausted).toBe(true);
    expect(res.body.resolution.state_source).toBe('credits.exhausted');
  });

  test('does not falsely report PROCESSING for a stale queued job', async () => {
    mockQuotaStatus();
    const getJobRecord = jest.fn().mockResolvedValue({
      jobId: 'job-stale',
      status: 'processing',
      total: 4,
      completed: 1,
      failed: 0,
      updatedAt: '2026-04-21T08:00:00.000Z',
      items: [
        { id: 'a', status: 'completed', stage: 'completed' },
        { id: 'b', status: 'generating', stage: 'generating' },
        { id: 'c', status: 'queued', stage: 'queued' },
        { id: 'd', status: 'queued', stage: 'queued' }
      ]
    });
    const app = createApp({
      supabase: createSupabaseMock({
        imageAltStates: buildImageAltStates({ approved: 9 })
      }),
      getJobRecord
    });

    const res = await request(app)
      .get('/dashboard/state-truth?job_id=job-stale')
      .set('X-Site-Key', 'site-hash-1');

    expect(res.status).toBe(200);
    expect(res.body.state).toBe('ALL_CLEAR');
    expect(res.body.job.status).toBe('FAILED');
    expect(res.body.job.active).toBe(false);
    expect(res.body.resolution.job_source).toBe('job_record_stale');
  });

  test('returns credits exactly from the shared quota resolver', async () => {
    mockQuotaStatus({
      credits_used: 17,
      credits_remaining: 83,
      total_limit: 100,
      plan_type: 'pro'
    });
    const app = createApp({
      supabase: createSupabaseMock({
        imageAltStates: buildImageAltStates({ approved: 20 })
      })
    });

    const res = await request(app).get('/dashboard/state-truth').set('X-Site-Key', 'site-hash-1');

    expect(res.status).toBe(200);
    expect(res.body.credits).toEqual({
      limit: 100,
      used: 17,
      remaining: 83,
      exhausted: false,
      source: 'license'
    });
    expect(getQuotaStatus).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      account: expect.objectContaining({ license_key: 'license-key-1' }),
      licenseKey: 'license-key-1',
      siteHash: 'site-hash-1'
    }));
  });

  test('falls back to generation_requests when no batch job id is supplied', async () => {
    mockQuotaStatus();
    const app = createApp({
      supabase: createSupabaseMock({
        imageAltStates: buildImageAltStates({ approved: 1 }),
        generationRequests: [
          {
            id: 'gen-1',
            site_id: 'site-1',
            status: 'reserved',
            created_at: new Date().toISOString(),
            finalized_at: null
          }
        ]
      })
    });

    const res = await request(app).get('/dashboard/state-truth').set('X-Site-Key', 'site-hash-1');

    expect(res.status).toBe(200);
    expect(res.body.state).toBe('PROCESSING');
    expect(res.body.job.status).toBe('PROCESSING');
    expect(res.body.job.generation_request_id).toBe('gen-1');
    expect(res.body.resolution.job_source).toBe('generation_requests');
  });

  test('returns ERROR instead of guessing ALL_CLEAR when no authoritative count source exists', async () => {
    mockQuotaStatus();
    const app = createApp({
      supabase: createSupabaseMock()
    });

    const res = await request(app).get('/dashboard/state-truth').set('X-Site-Key', 'site-hash-1');

    expect(res.status).toBe(200);
    expect(res.body.state).toBe('ERROR');
    expect(res.body.resolution.count_source).toBe('site_audit_logs:none');
  });
});
