/**
 * OPTIMIZER_AUDIT_ENABLED kill switch on /api/optimizer/*.
 * Off unless the env is exactly 'true': every audit route returns 503 and
 * startOptimizerAudit is never called.
 */
const express = require('express');
const request = require('supertest');

jest.mock('../../services/optimizerAudit', () => ({
  startOptimizerAudit: jest.fn(() => ({
    auditId: 'audit-test-id',
    status: 'running',
    siteUrl: 'https://example.com'
  })),
  getOptimizerAudit: jest.fn(async () => null),
  getOptimizerHistory: jest.fn(async () => [])
}));

jest.mock('../../services/optimizerProgress', () => ({
  getOptimizerProgress: jest.fn(async () => ({ weekly: null, achievements: [] }))
}));

const { createOptimizerRouter } = require('../../routes/optimizer');
const { startOptimizerAudit, getOptimizerAudit, getOptimizerHistory } = require('../../services/optimizerAudit');
const { getOptimizerProgress } = require('../../services/optimizerProgress');

describe('optimizer audit OPTIMIZER_AUDIT_ENABLED flag', () => {
  const previous = process.env.OPTIMIZER_AUDIT_ENABLED;

  afterEach(() => {
    if (previous === undefined) {
      delete process.env.OPTIMIZER_AUDIT_ENABLED;
    } else {
      process.env.OPTIMIZER_AUDIT_ENABLED = previous;
    }
    jest.clearAllMocks();
  });

  function buildApp({ authMethod = null } = {}) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      if (authMethod) {
        req.authMethod = authMethod;
        if (authMethod === 'license') {
          req.license = { id: 'lic-1', license_key: 'test-license', plan: 'pro', status: 'active' };
        }
        if (authMethod === 'jwt') {
          req.user = { id: 'user-1', email: 'user@example.com' };
        }
      }
      next();
    });
    app.use('/api/optimizer', createOptimizerRouter({ supabase: null }));
    return app;
  }

  describe('flag unset / off', () => {
    beforeEach(() => {
      delete process.env.OPTIMIZER_AUDIT_ENABLED;
    });

    test('POST /audit returns 503 for anonymous X-Site-Hash and does not start an audit', async () => {
      const app = buildApp();
      const res = await request(app)
        .post('/api/optimizer/audit')
        .set('X-Site-Hash', 'anon-site-hash')
        .set('X-Site-URL', 'https://example.com')
        .send({ siteUrl: 'https://example.com' })
        .expect(503);

      expect(res.body).toEqual({ error: 'OPTIMIZER_DISABLED', retryable: false });
      expect(startOptimizerAudit).not.toHaveBeenCalled();
    });

    test('POST /audit returns 503 for license auth and does not start an audit', async () => {
      const app = buildApp({ authMethod: 'license' });
      const res = await request(app)
        .post('/api/optimizer/audit')
        .set('X-License-Key', 'test-license')
        .set('X-Site-Hash', 'licensed-site-hash')
        .set('X-Site-URL', 'https://example.com')
        .send({ siteUrl: 'https://example.com' })
        .expect(503);

      expect(res.body).toEqual({ error: 'OPTIMIZER_DISABLED', retryable: false });
      expect(startOptimizerAudit).not.toHaveBeenCalled();
    });

    test('POST /audit returns 503 for JWT auth and does not start an audit', async () => {
      const app = buildApp({ authMethod: 'jwt' });
      const res = await request(app)
        .post('/api/optimizer/audit')
        .set('Authorization', 'Bearer fake-jwt')
        .set('X-Site-Hash', 'jwt-site-hash')
        .set('X-Site-URL', 'https://example.com')
        .send({ siteUrl: 'https://example.com' })
        .expect(503);

      expect(res.body).toEqual({ error: 'OPTIMIZER_DISABLED', retryable: false });
      expect(startOptimizerAudit).not.toHaveBeenCalled();
    });

    test('GET /audit/:id, /history and /progress all return 503 when flag is unset', async () => {
      const app = buildApp();

      const getAudit = await request(app)
        .get('/api/optimizer/audit/00000000-0000-0000-0000-000000000001')
        .expect(503);
      expect(getAudit.body).toEqual({ error: 'OPTIMIZER_DISABLED', retryable: false });
      expect(getOptimizerAudit).not.toHaveBeenCalled();

      const history = await request(app)
        .get('/api/optimizer/history')
        .set('X-Site-Hash', 'anon-site-hash')
        .expect(503);
      expect(history.body).toEqual({ error: 'OPTIMIZER_DISABLED', retryable: false });
      expect(getOptimizerHistory).not.toHaveBeenCalled();

      const progress = await request(app)
        .get('/api/optimizer/progress')
        .set('X-Site-Hash', 'anon-site-hash')
        .expect(503);
      expect(progress.body).toEqual({ error: 'OPTIMIZER_DISABLED', retryable: false });
      expect(getOptimizerProgress).not.toHaveBeenCalled();
    });

    test('flag set to anything other than exact "true" stays disabled', async () => {
      process.env.OPTIMIZER_AUDIT_ENABLED = '1';
      const app = buildApp();
      const res = await request(app)
        .post('/api/optimizer/audit')
        .set('X-Site-Hash', 'anon-site-hash')
        .send({ siteUrl: 'https://example.com' })
        .expect(503);
      expect(res.body.error).toBe('OPTIMIZER_DISABLED');
      expect(startOptimizerAudit).not.toHaveBeenCalled();
    });
  });

  describe("flag 'true' behaves as before", () => {
    beforeEach(() => {
      process.env.OPTIMIZER_AUDIT_ENABLED = 'true';
    });

    test('POST /audit starts an audit and returns 202', async () => {
      const app = buildApp({ authMethod: 'license' });
      const res = await request(app)
        .post('/api/optimizer/audit')
        .set('X-License-Key', 'test-license')
        .set('X-Site-Hash', 'licensed-site-hash')
        .set('X-Site-URL', 'https://example.com')
        .send({ siteUrl: 'https://example.com' })
        .expect(202);

      expect(res.body).toEqual({
        ok: true,
        auditId: 'audit-test-id',
        status: 'running'
      });
      expect(startOptimizerAudit).toHaveBeenCalledTimes(1);
      expect(startOptimizerAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          siteUrl: 'https://example.com',
          siteHash: 'licensed-site-hash'
        })
      );
    });

    test('GET /audit/:id, /history and /progress reach their handlers', async () => {
      getOptimizerAudit.mockResolvedValueOnce({
        auditId: 'audit-test-id',
        status: 'completed',
        siteUrl: 'https://example.com',
        startedAt: '2026-10-12T00:00:00.000Z',
        errorCode: null,
        result: { overallScore: 80 }
      });
      getOptimizerHistory.mockResolvedValueOnce([{ auditId: 'audit-test-id' }]);
      getOptimizerProgress.mockResolvedValueOnce({ weekly: { score: 80 }, achievements: [] });

      const app = buildApp();

      const getAudit = await request(app)
        .get('/api/optimizer/audit/audit-test-id')
        .expect(200);
      expect(getAudit.body.ok).toBe(true);
      expect(getOptimizerAudit).toHaveBeenCalledWith('audit-test-id', expect.any(Object));

      const history = await request(app)
        .get('/api/optimizer/history')
        .set('X-Site-Hash', 'anon-site-hash')
        .expect(200);
      expect(history.body).toEqual({ ok: true, audits: [{ auditId: 'audit-test-id' }] });

      const progress = await request(app)
        .get('/api/optimizer/progress')
        .set('X-Site-Hash', 'anon-site-hash')
        .expect(200);
      expect(progress.body.ok).toBe(true);
      expect(getOptimizerProgress).toHaveBeenCalled();
    });
  });
});
