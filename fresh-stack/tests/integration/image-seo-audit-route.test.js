const express = require('express');
const request = require('supertest');
const dns = require('dns').promises;
const { createImageSeoAuditRouter } = require('../../routes/imageSeoAudit');

describe('image SEO audit route', () => {
  beforeEach(() => {
    jest.spyOn(dns, 'lookup').mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function buildApp(runAudit = jest.fn().mockResolvedValue({ ok: true })) {
    const app = express();
    app.use(express.json());
    app.use('/api/image-seo-audit', createImageSeoAuditRouter({ supabase: null, runAudit }));
    return { app, runAudit };
  }

  test('queues a valid public audit request', async () => {
    const { app, runAudit } = buildApp();

    const res = await request(app)
      .post('/api/image-seo-audit')
      .send({
        email: 'lead@example.com',
        siteUrl: 'https://example.com',
        consent: true
      })
      .expect(202);

    expect(res.body).toEqual({
      ok: true,
      auditId: expect.any(String),
      status: 'queued'
    });

    await new Promise((resolve) => setImmediate(resolve));
    expect(runAudit).toHaveBeenCalledWith(expect.objectContaining({
      auditId: res.body.auditId,
      email: 'lead@example.com',
      siteUrl: 'https://example.com/'
    }));
  });

  test('rejects invalid email, missing consent, and private urls', async () => {
    const { app } = buildApp();

    await request(app)
      .post('/api/image-seo-audit')
      .send({ email: 'bad', siteUrl: 'https://example.com', consent: true })
      .expect(400);

    await request(app)
      .post('/api/image-seo-audit')
      .send({ email: 'lead@example.com', siteUrl: 'https://example.com' })
      .expect(400);

    await request(app)
      .post('/api/image-seo-audit')
      .send({ email: 'lead@example.com', siteUrl: 'http://127.0.0.1:3000', consent: true })
      .expect(400);
  });
});
