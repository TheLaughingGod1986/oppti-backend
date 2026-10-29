/**
 * trust proxy (Render, 1 hop by default): the /auth limiter keys on the real
 * client (rightmost X-Forwarded-For entry added by our proxy), not one shared
 * proxy address, and a client cannot choose its key by forging the header.
 * Other limiters keep their keys (license / site+ip).
 */
const express = require('express');
const request = require('supertest');

const rateLimitMiddleware = require('../../middleware/rateLimit');
const { resolveTrustProxyHops, createProxyHopObserver, DEFAULT_TRUST_PROXY_HOPS } = require('../../lib/trustProxy');

function buildApp(hops) {
  const app = express();
  if (hops !== undefined) app.set('trust proxy', hops);
  const seen = [];
  app.use((req, _res, next) => { seen.push(req.ip); next(); });
  app.use(rateLimitMiddleware({ redis: null }));
  app.all('*', (req, res) => res.json({ ok: true, ip: req.ip }));
  app.locals.seen = seen;
  return app;
}

const savedLimit = process.env.AUTH_RATE_LIMIT_PER_IP;
beforeAll(() => { process.env.AUTH_RATE_LIMIT_PER_IP = '3'; });
afterAll(() => {
  if (savedLimit === undefined) delete process.env.AUTH_RATE_LIMIT_PER_IP;
  else process.env.AUTH_RATE_LIMIT_PER_IP = savedLimit;
});

async function hit(app, path, xff, headers = {}) {
  let req = request(app).post(path);
  if (xff) req = req.set('X-Forwarded-For', xff);
  for (const [k, v] of Object.entries(headers)) req = req.set(k, v);
  return req.send({});
}

describe('resolveTrustProxyHops', () => {
  test.each([
    [undefined, 1], ['', 1], ['1', 1], ['3', 3], ['0', 0], ['-1', 1], ['true', 1], ['2.5', 1], ['99', 1]
  ])('TRUST_PROXY_HOPS=%p -> %p', (value, expected) => {
    expect(resolveTrustProxyHops(value === undefined ? {} : { TRUST_PROXY_HOPS: value })).toBe(expected);
  });

  test('default is 1 hop (never `true`)', () => {
    expect(DEFAULT_TRUST_PROXY_HOPS).toBe(1);
  });
});

describe('/auth rate limit key with trust proxy = 1', () => {
  test('two clients behind the proxy get separate buckets', async () => {
    const app = buildApp(1);
    for (let i = 0; i < 3; i += 1) {
      expect((await hit(app, '/auth/login', '203.0.113.10')).status).toBe(200);
    }
    expect((await hit(app, '/auth/login', '203.0.113.10')).status).toBe(429);
    expect((await hit(app, '/auth/login', '198.51.100.20')).status).toBe(200);
    expect(app.locals.seen).toContain('203.0.113.10');
    expect(app.locals.seen).toContain('198.51.100.20');
  });

  test('a forged leftmost X-Forwarded-For entry does not change the key', async () => {
    const app = buildApp(1);
    for (let i = 0; i < 3; i += 1) {
      expect((await hit(app, '/auth/forgot-password', `10.0.0.${i}, 203.0.113.30`)).status).toBe(200);
    }
    expect((await hit(app, '/auth/forgot-password', '1.2.3.4, 203.0.113.30')).status).toBe(429);
    expect(app.locals.seen.every((ip) => ip === '203.0.113.30')).toBe(true);
  });

  test('without trust proxy (the old setting) every client shares the proxy socket bucket', async () => {
    const app = buildApp(undefined);
    for (let i = 0; i < 3; i += 1) {
      await hit(app, '/auth/login', `203.0.113.${40 + i}`);
    }
    expect((await hit(app, '/auth/login', '198.51.100.99')).status).toBe(429);
  });

  test('license-keyed limits are unaffected by the client IP', async () => {
    process.env.RATE_LIMIT_PER_SITE = '';
    const app = buildApp(1);
    const statuses = [];
    for (let i = 0; i < 62; i += 1) {
      statuses.push((await hit(app, '/api/titles/quota', `203.0.113.${i % 200}`, { 'X-License-Key': 'lic-shared' })).status);
    }
    // Free plan limit is 60/min per license regardless of which client IP sends it.
    expect(statuses.filter((s) => s === 429)).toHaveLength(2);
  });
});

describe('proxy hop observer', () => {
  test('logs the X-Forwarded-For entry count once, never an address', async () => {
    const logger = { info: jest.fn() };
    const app = express();
    app.set('trust proxy', 1);
    app.use(createProxyHopObserver({ logger, hops: 1 }));
    app.get('/', (_req, res) => res.json({ ok: true }));
    await request(app).get('/').set('X-Forwarded-For', '203.0.113.7, 10.1.2.3');
    await request(app).get('/').set('X-Forwarded-For', '203.0.113.8');
    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.info.mock.calls[0][1]).toEqual({ x_forwarded_for_entries: 2, trust_proxy_hops: 1, has_cf_connecting_ip: false });
    expect(JSON.stringify(logger.info.mock.calls)).not.toMatch(/203\.0\.113|10\.1\.2\.3/);
  });
});
