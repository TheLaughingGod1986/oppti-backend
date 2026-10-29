/**
 * The real app sets Express 'trust proxy' to a hop count (1 by default,
 * TRUST_PROXY_HOPS overrides), so /auth is limited per client on Render.
 */
const request = require('supertest');

describe('server trust proxy', () => {
  const saved = { hops: process.env.TRUST_PROXY_HOPS, limit: process.env.AUTH_RATE_LIMIT_PER_IP };
  afterEach(() => {
    if (saved.hops === undefined) delete process.env.TRUST_PROXY_HOPS; else process.env.TRUST_PROXY_HOPS = saved.hops;
    if (saved.limit === undefined) delete process.env.AUTH_RATE_LIMIT_PER_IP; else process.env.AUTH_RATE_LIMIT_PER_IP = saved.limit;
  });

  function loadApp() {
    jest.resetModules();
    process.env.NODE_ENV = 'test';
    const { createApp } = require('../../server');
    return createApp({ supabaseClient: null, redisClient: null });
  }

  test('defaults to 1 hop; TRUST_PROXY_HOPS overrides', () => {
    delete process.env.TRUST_PROXY_HOPS;
    expect(loadApp().get('trust proxy')).toBe(1);
    process.env.TRUST_PROXY_HOPS = '3';
    expect(loadApp().get('trust proxy')).toBe(3);
  });

  test('/auth limiter is per client through the real app', async () => {
    delete process.env.TRUST_PROXY_HOPS;
    process.env.AUTH_RATE_LIMIT_PER_IP = '2';
    const app = loadApp();
    const send = (ip) => request(app).post('/auth/forgot-password').set('X-Forwarded-For', ip).send({ email: 'not-an-email' });
    expect((await send('203.0.113.50')).status).not.toBe(429);
    expect((await send('203.0.113.50')).status).not.toBe(429);
    expect((await send('203.0.113.50')).status).toBe(429);
    expect((await send('198.51.100.60')).status).not.toBe(429);
  });
});
