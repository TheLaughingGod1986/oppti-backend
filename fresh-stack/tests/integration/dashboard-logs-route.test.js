const express = require('express');
const request = require('supertest');

const { createDashboardRouter } = require('../../routes/dashboard');

function createAuthorizedSessionQuery(sessionData) {
  return {
    eq(column, value) {
      if (column === 'session_token') {
        this._sessionToken = value;
      }
      return this;
    },
    single: async () => ({
      data: sessionData,
      error: sessionData ? null : { message: 'not found' }
    })
  };
}

function createSupabaseMock({ sessionData = null } = {}) {
  return {
    from(table) {
      if (table === 'dashboard_sessions') {
        return {
          select() {
            return createAuthorizedSessionQuery(sessionData);
          }
        };
      }

      if (table === 'debug_logs') {
        throw new Error('debug_logs should not be queried by /dashboard/logs');
      }

      throw new Error(`Unexpected table ${table}`);
    }
  };
}

function createApp(supabase) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.id = 'req-dashboard-logs';
    next();
  });
  app.use('/dashboard', createDashboardRouter({ supabase }));
  return app;
}

describe('GET /dashboard/logs', () => {
  test('returns 401 when the dashboard session is invalid', async () => {
    const app = createApp(createSupabaseMock());

    const response = await request(app)
      .get('/dashboard/logs')
      .set('Authorization', 'Bearer missing-session');

    expect(response.status).toBe(401);
    expect(response.body).toEqual({
      error: 'INVALID_SESSION'
    });
  });

  test('returns explicit deprecation response without reading debug_logs', async () => {
    const app = createApp(createSupabaseMock({
      sessionData: {
        license_key: 'lic_debug_123'
      }
    }));

    const response = await request(app)
      .get('/dashboard/logs')
      .set('Authorization', 'Bearer valid-session');

    expect(response.status).toBe(410);
    expect(response.body).toEqual({
      success: false,
      error: 'DASHBOARD_LOGS_DEPRECATED',
      message: 'Dashboard database logs are no longer available. Use admin diagnostics and structured application logs instead.',
      deprecated: true,
      logs: [],
      data: {
        logs: [],
        source: 'diagnostics_and_app_logs',
        deprecated: true
      }
    });
  });
});
