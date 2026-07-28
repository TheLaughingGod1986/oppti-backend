/**
 * /v1/* is a pure aliasing layer — these tests use small stub routers
 * instead of the full titles/altText/jobs/billing routers so they verify
 * exactly one thing: that each /v1 path rewrites to the right underlying
 * path and method on the right router, nothing more.
 */
const express = require('express');
const request = require('supertest');
const { createV1Router } = require('../../routes/v1');

function stubRouter(routes) {
  const router = express.Router();
  routes.forEach(({ method, path, handler }) => {
    router[method](path, handler);
  });
  return router;
}

describe('createV1Router', () => {
  let app;
  let hits;

  beforeEach(() => {
    hits = [];

    const titlesRouter = stubRouter([
      { method: 'post', path: '/generate', handler: (req, res) => { hits.push('titles:/generate'); res.json({ ok: true, from: 'titles-generate' }); } },
      { method: 'get', path: '/quota', handler: (req, res) => { hits.push('titles:/quota'); res.json({ ok: true, from: 'titles-quota' }); } }
    ]);

    const altTextRouter = stubRouter([
      { method: 'post', path: '/', handler: (req, res) => { hits.push('altText:/'); res.json({ ok: true, from: 'alttext-generate' }); } }
    ]);

    const jobsRouter = stubRouter([
      { method: 'post', path: '/', handler: (req, res) => { hits.push('jobs:/'); res.json({ ok: true, from: 'jobs-submit' }); } },
      { method: 'get', path: '/:jobId', handler: (req, res) => { hits.push(`jobs:/${req.params.jobId}`); res.json({ ok: true, jobId: req.params.jobId }); } },
      { method: 'post', path: '/:jobId/cancel', handler: (req, res) => { hits.push(`jobs:/${req.params.jobId}/cancel`); res.json({ ok: true, cancelled: req.params.jobId }); } },
      { method: 'post', path: '/:jobId/retry', handler: (req, res) => { hits.push(`jobs:/${req.params.jobId}/retry`); res.json({ ok: true, retried: req.params.jobId }); } }
    ]);

    const billingRouter = stubRouter([
      { method: 'get', path: '/info', handler: (req, res) => { hits.push('billing:/info'); res.json({ ok: true, from: 'billing-info' }); } }
    ]);

    app = express();
    app.use(express.json());
    app.use('/v1', createV1Router({ titlesRouter, altTextRouter, jobsRouter, billingRouter }));
  });

  test('POST /v1/optimise/title forwards to titles /generate', async () => {
    const res = await request(app).post('/v1/optimise/title').send({});
    expect(res.status).toBe(200);
    expect(res.body.from).toBe('titles-generate');
    expect(hits).toEqual(['titles:/generate']);
  });

  test('POST /v1/optimise/meta-description forwards to titles /generate', async () => {
    const res = await request(app).post('/v1/optimise/meta-description').send({});
    expect(res.body.from).toBe('titles-generate');
  });

  test('POST /v1/optimise/metadata forwards to titles /generate', async () => {
    const res = await request(app).post('/v1/optimise/metadata').send({});
    expect(res.body.from).toBe('titles-generate');
  });

  test('POST /v1/optimise/alt-text forwards to alt-text root', async () => {
    const res = await request(app).post('/v1/optimise/alt-text').send({});
    expect(res.body.from).toBe('alttext-generate');
    expect(hits).toEqual(['altText:/']);
  });

  test('POST /v1/optimise/bulk forwards to jobs root', async () => {
    const res = await request(app).post('/v1/optimise/bulk').send({});
    expect(res.body.from).toBe('jobs-submit');
  });

  test('POST /v1/jobs forwards to jobs root', async () => {
    const res = await request(app).post('/v1/jobs').send({});
    expect(res.body.from).toBe('jobs-submit');
  });

  test('GET /v1/jobs/:jobId forwards to jobs/:jobId with the param intact', async () => {
    const res = await request(app).get('/v1/jobs/abc-123');
    expect(res.body.jobId).toBe('abc-123');
    expect(hits).toEqual(['jobs:/abc-123']);
  });

  test('POST /v1/jobs/:jobId/cancel forwards correctly', async () => {
    const res = await request(app).post('/v1/jobs/abc-123/cancel');
    expect(res.body.cancelled).toBe('abc-123');
  });

  test('POST /v1/jobs/:jobId/retry forwards correctly', async () => {
    const res = await request(app).post('/v1/jobs/abc-123/retry');
    expect(res.body.retried).toBe('abc-123');
  });

  test('GET /v1/account/credits forwards to titles /quota', async () => {
    const res = await request(app).get('/v1/account/credits');
    expect(res.body.from).toBe('titles-quota');
    expect(hits).toEqual(['titles:/quota']);
  });

  test('GET /v1/account forwards to billing /info', async () => {
    const res = await request(app).get('/v1/account');
    expect(res.body.from).toBe('billing-info');
    expect(hits).toEqual(['billing:/info']);
  });
});
