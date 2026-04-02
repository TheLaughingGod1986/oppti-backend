const express = require('express');
const request = require('supertest');

jest.mock('../../lib/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  getRecentEntries: jest.fn().mockReturnValue([
    {
      timestamp: '2026-04-02T12:00:00.000Z',
      level: 'error',
      message: '[V2_SCHEMA_CRITICAL] V2 schema is not deployed; backend is running on legacy fallback',
      context: []
    }
  ]),
  clearRecentEntries: jest.fn()
}));

const { createAdminRouter } = require('../../routes/admin');

function buildCountResponse({ count = 0, error = null } = {}) {
  return {
    select() {
      return {
        limit: async () => ({ count, error }),
        gte: async () => ({ count, error })
      };
    }
  };
}

function createDiagnosticsSupabaseMock() {
  const missingSchemaError = {
    code: 'PGRST202',
    message: 'Could not find the function in the schema cache'
  };

  return {
    rpc: async () => ({ data: null, error: missingSchemaError }),
    from(table) {
      if (['plans', 'site_memberships', 'site_subscriptions', 'site_quotas', 'site_trials', 'generation_requests', 'usage_events', 'site_audit_logs'].includes(table)) {
        return buildCountResponse({ error: missingSchemaError });
      }

      if (table === 'sites') {
        return buildCountResponse({ count: 4, error: null });
      }

      if (table === 'trial_usage') {
        return buildCountResponse({ count: 7, error: null });
      }

      if (table === 'usage_logs') {
        return buildCountResponse({ count: 9, error: null });
      }

      return buildCountResponse({ count: 0, error: null });
    }
  };
}

describe('GET /admin/diagnostics/pipeline', () => {
  const originalAdminKey = process.env.ADMIN_KEY;

  beforeEach(() => {
    process.env.ADMIN_KEY = 'test-admin-key';
  });

  afterEach(() => {
    process.env.ADMIN_KEY = originalAdminKey;
  });

  test('returns schema and count diagnostics when V2 functions are missing', async () => {
    const app = express();
    app.use('/admin', createAdminRouter({
      redis: null,
      supabase: createDiagnosticsSupabaseMock(),
      resultCache: new Map()
    }));

    const response = await request(app)
      .get('/admin/diagnostics/pipeline')
      .set('X-Admin-Key', 'test-admin-key');

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.diagnostics.v2_schema.available).toBe(false);
    expect(response.body.diagnostics.v2_schema.fallback_mode).toBe(true);
    expect(response.body.diagnostics.v2_schema.missing_functions).toEqual(expect.arrayContaining([
      'bbai_reserve_site_generation',
      'bbai_finalize_site_generation'
    ]));
    expect(response.body.diagnostics.counts_last_7d.sites).toEqual(expect.objectContaining({
      available: true,
      count: 4
    }));
    expect(response.body.diagnostics.counts_last_7d.trial_usage).toEqual(expect.objectContaining({
      available: true,
      count: 7
    }));
    expect(response.body.diagnostics.counts_last_7d.usage_logs).toEqual(expect.objectContaining({
      available: true,
      count: 9
    }));
    expect(response.body.diagnostics.counts_last_7d.generation_requests.available).toBe(false);
    expect(response.body.diagnostics.recent_log_summary).toHaveLength(1);
  });
});
