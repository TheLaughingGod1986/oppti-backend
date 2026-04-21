const express = require('express');
const request = require('supertest');

const diagnosticsPayload = {
  runtime: {
    service_name: 'alttext-ai-api',
    route_version_marker: 'data-integrity-runtime-v1',
    supabase_url_host: 'diag-project.supabase.co'
  },
  environment: {
    node_env: 'test',
    supabase_url_host: 'diag-project.supabase.co',
    has_service_role_key: true,
    loops_enabled: true,
    stripe_enabled: true
  },
  schema: {
    has_v2_tables: {},
    has_v2_rpcs: {},
    has_trigger_trg_update_quota_summary: true
  },
  recent_activity: {
    licenses_last_7d: 1,
    sites_last_7d: 1,
    trial_usage_last_7d: 1,
    usage_logs_last_7d: 1,
    subscriptions_last_7d: 0,
    dashboard_sessions_last_7d: 0,
    debug_logs_last_7d: 0
  },
  classification: {
    active: ['licenses', 'sites'],
    legacy: ['subscriptions'],
    dead: ['debug_logs'],
    expected_empty: ['dashboard_sessions']
  },
  write_paths: {
    signup_creates_license: true
  },
  write_path_health: {
    signup_creates_license: {
      code_path_present: true,
      recent_table_evidence: true
    }
  },
  table_health: {
    sites: {
      total_count: 1,
      last_7d_count: 1,
      classification: 'ACTIVE'
    }
  },
  recent_warnings_errors: [],
  suspicions: []
};

jest.mock('../../services/dataIntegrityDiagnostics', () => ({
  buildDataIntegrityDiagnostics: jest.fn().mockResolvedValue(diagnosticsPayload)
}));

const { buildDataIntegrityDiagnostics } = require('../../services/dataIntegrityDiagnostics');
const { createAdminRouter } = require('../../routes/admin');
const { runDataIntegrityDiagnosticsCli } = require('../../scripts/print-data-integrity-diagnostics');

describe('data-integrity diagnostics CLI', () => {
  const originalAdminKey = process.env.ADMIN_KEY;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.ADMIN_KEY = 'test-admin-key';
  });

  afterEach(() => {
    process.env.ADMIN_KEY = originalAdminKey;
  });

  test('prints the diagnostics object and reuses the same builder as the admin route', async () => {
    const stdoutChunks = [];
    const stderrChunks = [];
    const fakeSupabase = { tag: 'supabase' };

    const cliResult = await runDataIntegrityDiagnosticsCli({
      argv: ['--pretty'],
      supabase: fakeSupabase,
      stdout: {
        write: (chunk) => stdoutChunks.push(chunk)
      },
      stderr: {
        write: (chunk) => stderrChunks.push(chunk)
      },
      exit: jest.fn()
    });

    expect(cliResult).toEqual(diagnosticsPayload);
    expect(stderrChunks).toHaveLength(0);
    expect(buildDataIntegrityDiagnostics).toHaveBeenCalledWith(fakeSupabase, { days: 7 });

    const parsedCliOutput = JSON.parse(stdoutChunks.join(''));
    expect(parsedCliOutput).toEqual(expect.objectContaining({
      runtime: expect.any(Object),
      environment: expect.any(Object),
      schema: expect.any(Object),
      recent_activity: expect.any(Object),
      classification: expect.any(Object),
      write_paths: expect.any(Object),
      write_path_health: expect.any(Object),
      table_health: expect.any(Object),
      recent_warnings_errors: expect.any(Array),
      suspicions: expect.any(Array)
    }));

    const app = express();
    app.use('/admin', createAdminRouter({
      redis: null,
      supabase: fakeSupabase,
      resultCache: new Map()
    }));

    const response = await request(app)
      .get('/admin/diagnostics/data-integrity')
      .set('X-Admin-Key', 'test-admin-key');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      success: true,
      diagnostics: diagnosticsPayload
    });
    expect(buildDataIntegrityDiagnostics).toHaveBeenNthCalledWith(2, fakeSupabase, {
      days: 7,
      runtimeIdentity: null
    });
  });

  test('returns a structured missing-env error before loading diagnostics dependencies', async () => {
    const stdoutChunks = [];
    const stderrChunks = [];
    const exit = jest.fn();

    const cliResult = await runDataIntegrityDiagnosticsCli({
      argv: ['--pretty'],
      env: {},
      stdout: {
        write: (chunk) => stdoutChunks.push(chunk)
      },
      stderr: {
        write: (chunk) => stderrChunks.push(chunk)
      },
      supabaseLoader: jest.fn(),
      exit
    });

    expect(cliResult).toBeNull();
    expect(stdoutChunks).toHaveLength(0);
    expect(exit).toHaveBeenCalledWith(1);
    expect(buildDataIntegrityDiagnostics).not.toHaveBeenCalled();

    const parsedError = JSON.parse(stderrChunks.join(''));
    expect(parsedError).toEqual({
      success: false,
      error: 'MISSING_REQUIRED_ENV',
      missing: ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'],
      message: 'Run this command inside the backend runtime environment (e.g. Render shell) or load the backend env vars first.',
      operator_hints: [
        'printenv | grep SUPABASE',
        'echo $SUPABASE_URL'
      ]
    });
  });
});
