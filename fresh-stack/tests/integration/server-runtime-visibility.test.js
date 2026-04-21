const request = require('supertest');

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

describe('fresh-stack server runtime visibility', () => {
  const originalAdminKey = process.env.ADMIN_KEY;
  const originalSupabaseUrl = process.env.SUPABASE_URL;
  const originalServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const originalLoopsApiKey = process.env.LOOPS_API_KEY;
  const originalStripeSecretKey = process.env.STRIPE_SECRET_KEY;
  const originalFetch = global.fetch;

  beforeEach(() => {
    jest.resetModules();
    process.env.NODE_ENV = 'test';
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

  test('health exposes runtime/build identity fields', async () => {
    const { createApp } = require('../../server');
    const app = createApp({
      supabaseClient: createDiagnosticsSupabaseMock(),
      redisClient: null
    });

    const response = await request(app).get('/health');

    expect(response.status).toBe(200);
    expect(response.body).toEqual(expect.objectContaining({
      ok: true,
      service: 'alttext-ai-api',
      runtime: expect.objectContaining({
        app_version: expect.any(String),
        diagnostics_route_enabled: true,
        node_env: 'test',
        route_version_marker: expect.any(String),
        server_entry: 'fresh-stack/server.js',
        service_name: 'alttext-ai-api',
        supabase_url_host: 'diag-project.supabase.co'
      })
    }));
  });

  test('admin diagnostics route is mounted, protected, and returns expected keys', async () => {
    const { createApp } = require('../../server');
    const app = createApp({
      supabaseClient: createDiagnosticsSupabaseMock(),
      redisClient: null
    });

    const unauthorized = await request(app).get('/admin/diagnostics/data-integrity');

    expect(unauthorized.status).toBe(401);
    expect(unauthorized.body).toEqual(expect.objectContaining({
      error: 'Unauthorized',
      message: 'Invalid admin key'
    }));

    const authorized = await request(app)
      .get('/admin/diagnostics/data-integrity')
      .set('X-Admin-Key', 'test-admin-key');

    expect(authorized.status).toBe(200);
    expect(authorized.body.success).toBe(true);
    expect(authorized.body.diagnostics).toEqual(expect.objectContaining({
      runtime: expect.objectContaining({
        diagnostics_route_enabled: true,
        route_version_marker: expect.any(String),
        supabase_url_host: 'diag-project.supabase.co'
      }),
      environment: expect.objectContaining({
        node_env: 'test',
        supabase_url_host: 'diag-project.supabase.co',
        has_service_role_key: true,
        loops_enabled: true,
        stripe_enabled: true
      }),
      schema: expect.any(Object),
      recent_activity: expect.any(Object),
      classification: expect.objectContaining({
        active: expect.any(Array),
        legacy: expect.any(Array),
        dead: expect.any(Array),
        expected_empty: expect.any(Array)
      }),
      recent_warnings_errors: expect.any(Array)
    }));
  });
});
