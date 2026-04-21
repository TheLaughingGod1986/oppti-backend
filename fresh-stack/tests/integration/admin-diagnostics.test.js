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

function buildCountResponse({ count = 0, error = null, data = [] } = {}) {
  return {
    select() {
      return {
        limit: async () => ({ count, error }),
        gte: async () => ({ count, error }),
        order() {
          return {
            limit: async () => ({ data, error })
          };
        }
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
  const originalSupabaseUrl = process.env.SUPABASE_URL;
  const originalServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const originalLoopsApiKey = process.env.LOOPS_API_KEY;
  const originalStripeSecretKey = process.env.STRIPE_SECRET_KEY;
  const originalFetch = global.fetch;

  beforeEach(() => {
    process.env.ADMIN_KEY = 'test-admin-key';
    process.env.SUPABASE_URL = 'https://diag-project.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-test-key';
    process.env.LOOPS_API_KEY = 'loops-test-key';
    process.env.STRIPE_SECRET_KEY = 'sk_test_123';
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ([{ trigger_name: 'trg_update_quota_summary' }]),
      text: async () => 'ok'
    });
  });

  afterEach(() => {
    process.env.ADMIN_KEY = originalAdminKey;
    process.env.SUPABASE_URL = originalSupabaseUrl;
    process.env.SUPABASE_SERVICE_ROLE_KEY = originalServiceRoleKey;
    process.env.LOOPS_API_KEY = originalLoopsApiKey;
    process.env.STRIPE_SECRET_KEY = originalStripeSecretKey;
    global.fetch = originalFetch;
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

  test('returns data integrity diagnostics with environment, schema, and table health', async () => {
    const app = express();
    app.use('/admin', createAdminRouter({
      redis: null,
      supabase: createDiagnosticsSupabaseMock(),
      resultCache: new Map()
    }));

    const response = await request(app)
      .get('/admin/diagnostics/data-integrity')
      .set('X-Admin-Key', 'test-admin-key');

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.diagnostics.environment).toEqual(expect.objectContaining({
      node_env: expect.any(String),
      supabase_url_host: 'diag-project.supabase.co',
      has_service_role_key: true,
      loops_enabled: true,
      stripe_enabled: true
    }));
    expect(response.body.diagnostics.schema.has_v2_tables.site_subscriptions).toBe(false);
    expect(response.body.diagnostics.schema.has_trigger_trg_update_quota_summary).toBe(true);
    expect(response.body.diagnostics.recent_activity).toEqual(expect.objectContaining({
      licenses_last_7d: 0,
      sites_last_7d: 4,
      trial_usage_last_7d: 7,
      usage_logs_last_7d: 9
    }));
    expect(response.body.diagnostics.write_paths).toEqual(expect.objectContaining({
      signup_creates_license: true,
      generation_writes_usage_logs: true,
      generation_writes_trial_usage: true,
      billing_writes_subscriptions: false
    }));
    expect(response.body.diagnostics.table_health.sites).toEqual(expect.objectContaining({
      total_count: 4,
      last_7d_count: 4
    }));
    expect(response.body.diagnostics.table_health.debug_logs.classification).toBe('DEAD');
    expect(Array.isArray(response.body.diagnostics.suspicions)).toBe(true);
  });
});
