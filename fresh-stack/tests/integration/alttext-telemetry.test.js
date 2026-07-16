const express = require('express');
const request = require('supertest');
const { generateAltText } = require('../../lib/openai');
const { captureServerEvent } = require('../../lib/posthog');
const quotaService = require('../../services/quota');

jest.mock('../../lib/openai', () => ({
  generateAltText: jest.fn().mockResolvedValue({
    altText: 'mock alt',
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    meta: { modelUsed: 'mock', generation_time_ms: 1 }
  })
}));

jest.mock('../../lib/posthog', () => ({
  captureServerEvent: jest.fn().mockResolvedValue({ ok: true })
}));

jest.mock('../../services/quota', () => ({
  reserveGenerationQuota: jest.fn().mockResolvedValue({
    error: null,
    reservation: { generation_request_id: 'generation_request_123' },
    site: { id: 'site_1', site_hash: 'site-key-1', license_key: 'key-123' }
  }),
  finalizeGenerationQuotaReservation: jest.fn().mockResolvedValue({ error: null }),
  getQuotaStatus: jest.fn().mockResolvedValue({
    plan_type: 'pro',
    credits_used: 0,
    credits_remaining: 1000,
    total_limit: 1000
  })
}));

jest.mock('../../services/usage', () => ({
  recordUsage: jest.fn().mockResolvedValue({ error: null, data: { id: 'usage_1' } })
}));

jest.mock('../../services/imageAltState', () => ({
  upsertGeneratedImageAltState: jest.fn().mockResolvedValue({ data: { id: 'state_1' }, error: null })
}));

const { createAltTextRouter } = require('../../routes/altText');

// AVIF magic bytes: ISO-BMFF box with an 'ftypavif' brand — the format that
// caused the 15 July 2026 incident (5 images retried 3x each by the client).
const AVIF_B64 = Buffer.concat([
  Buffer.from([0x00, 0x00, 0x00, 0x1c]),
  Buffer.from('ftypavif'),
  Buffer.alloc(52, 1)
]).toString('base64');

function createChainableMock() {
  const chainable = {
    select: () => chainable,
    eq: () => chainable,
    order: () => chainable,
    limit: () => chainable,
    insert: () => chainable,
    update: () => chainable,
    upsert: () => chainable,
    single: () => Promise.resolve({ data: null, error: null }),
    maybeSingle: () => Promise.resolve({ data: null, error: null }),
    then: (resolve, reject) => Promise.resolve({ data: [], error: null }).then(resolve, reject)
  };
  return chainable;
}

function buildApp() {
  const app = express();
  app.use(express.json({ limit: '8mb' }));
  app.use('/api/alt-text', createAltTextRouter({
    supabase: { from: () => createChainableMock() },
    redis: null,
    resultCache: new Map(),
    checkRateLimit: async () => true,
    getSiteFromHeaders: async () => null
  }));
  return app;
}

function providerError({ code, errorCode, httpStatusForClient, isRetryable, message = 'provider failure', httpStatus = null }) {
  const error = new Error(message);
  error.code = code;
  error.errorCode = errorCode;
  error.httpStatus = httpStatus;
  error.httpStatusForClient = httpStatusForClient;
  error.isRetryable = isRetryable;
  return error;
}

function capturedEvents() {
  return captureServerEvent.mock.calls.map(([payload]) => payload);
}

function terminalEvents() {
  return capturedEvents().filter((event) => event.properties.is_terminal === true);
}

// Analytics events must never carry image contents, prompts, credentials or
// personal data. Everything else is fair game.
const FORBIDDEN_PROPERTY_KEYS = ['base64', 'image_base64', 'prompt', 'api_key', 'email', 'user_email', 'altText'];

function assertNoSensitiveProperties(event) {
  for (const key of Object.keys(event.properties)) {
    expect(FORBIDDEN_PROPERTY_KEYS).not.toContain(key);
  }
  const serialized = JSON.stringify(event);
  expect(serialized).not.toContain(AVIF_B64.slice(0, 40));
  expect(serialized).not.toContain('@');
}

async function flushAsyncEvents() {
  await new Promise((resolve) => setImmediate(resolve));
}

describe('alt-text generation telemetry', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    generateAltText.mockResolvedValue({
      altText: 'mock alt',
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      meta: { modelUsed: 'mock', generation_time_ms: 1 }
    });
    quotaService.reserveGenerationQuota.mockResolvedValue({
      error: null,
      reservation: { generation_request_id: 'generation_request_123' },
      site: { id: 'site_1', site_hash: 'site-key-1', license_key: 'key-123' }
    });
  });

  test('successful generation emits exactly one terminal generation_completed with correlation properties', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/alt-text')
      .set('X-Site-Key', 'site-hash-1')
      .set('X-Plugin-Version', '2.3.1')
      .send({ image: { url: 'https://example.com/img.jpg', width: 1, height: 1 } });
    await flushAsyncEvents();

    expect(res.status).toBe(200);
    expect(res.body.generation_run_id).toEqual(expect.any(String));
    expect(res.headers['x-generation-run-id']).toBe(res.body.generation_run_id);

    const terminals = terminalEvents();
    expect(terminals).toHaveLength(1);
    expect(terminals[0].event).toBe('generation_completed');
    expect(terminals[0].properties).toMatchObject({
      generation_run_id: res.body.generation_run_id,
      error_code: null,
      http_status: 200,
      plugin_version: '2.3.1',
      generation_mode: 'single',
      retry_count: 0,
      provider: 'openai',
      is_terminal: true,
      site_hash: 'site-hash-1'
    });
    expect(terminals[0].properties.duration_ms).toEqual(expect.any(Number));
    assertNoSensitiveProperties(terminals[0]);
  });

  test('client-supplied generation_run_id and retry attempt propagate to events and response', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/alt-text')
      .set('X-Site-Key', 'site-hash-1')
      .set('X-Generation-Run-ID', 'run-abc-123')
      .set('X-Generation-Attempt', '2')
      .send({ image: { url: 'https://example.com/img.jpg', width: 1, height: 1 } });
    await flushAsyncEvents();

    expect(res.status).toBe(200);
    expect(res.body.generation_run_id).toBe('run-abc-123');
    expect(terminalEvents()[0].properties).toMatchObject({
      generation_run_id: 'run-abc-123',
      retry_count: 2
    });
  });

  test('AVIF upload fails fast as terminal 400 without reserving quota or calling the provider (incident repro)', async () => {
    const app = buildApp();

    // Reproduce the client behaviour observed on 15 July 2026: the plugin
    // retried each rejected image 3 times. With the fix every attempt is a
    // cheap, terminal 400 — no provider call, no quota reservation, and no
    // 5xx that invites more retries.
    const responses = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      responses.push(await request(app)
        .post('/api/alt-text')
        .set('X-Site-Key', 'site-hash-1')
        .set('X-Generation-Run-ID', 'run-avif-1')
        .set('X-Generation-Attempt', String(attempt))
        .send({ image: { base64: AVIF_B64, filename: 'Laundry.avif', width: 10, height: 10 } }));
    }
    await flushAsyncEvents();

    for (const res of responses) {
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({
        code: 'INVALID_REQUEST',
        error_code: 'invalid_request',
        generation_run_id: 'run-avif-1',
        retryable: false
      });
    }
    expect(generateAltText).not.toHaveBeenCalled();
    expect(quotaService.reserveGenerationQuota).not.toHaveBeenCalled();

    const terminals = terminalEvents();
    expect(terminals).toHaveLength(3); // one per HTTP request
    for (const event of terminals) {
      expect(event.event).toBe('generation_failed');
      expect(event.properties).toMatchObject({
        generation_run_id: 'run-avif-1',
        error_code: 'invalid_request',
        http_status: 400
      });
      assertNoSensitiveProperties(event);
    }
  });

  test.each([
    ['provider auth error', { code: 'BACKEND_CONFIG_ERROR', errorCode: 'provider_auth_error', httpStatusForClient: 502, isRetryable: false }, 502, false],
    ['provider rate limit', { code: 'UPSTREAM_RATE_LIMITED', errorCode: 'provider_rate_limited', httpStatusForClient: 503, isRetryable: true }, 503, true],
    ['provider timeout', { code: 'UPSTREAM_GENERATION_ERROR', errorCode: 'provider_timeout', httpStatusForClient: 504, isRetryable: true }, 504, true],
    ['provider connection failure', { code: 'UPSTREAM_GENERATION_ERROR', errorCode: 'provider_connection_error', httpStatusForClient: 502, isRetryable: true }, 502, true],
    ['provider rejected image', { code: 'INVALID_REQUEST', errorCode: 'invalid_request', httpStatusForClient: 400, isRetryable: false }, 400, false]
  ])('%s emits exactly one terminal generation_failed with the normalized code', async (_label, errorShape, expectedStatus, expectedRetryable) => {
    generateAltText.mockRejectedValueOnce(providerError(errorShape));
    const app = buildApp();

    const res = await request(app)
      .post('/api/alt-text')
      .set('X-Site-Key', 'site-hash-1')
      .send({ image: { url: 'https://example.com/img.jpg', width: 1, height: 1 } });
    await flushAsyncEvents();

    expect(res.status).toBe(expectedStatus);
    expect(res.body).toMatchObject({
      code: errorShape.code,
      error_code: errorShape.errorCode,
      retryable: expectedRetryable,
      generation_run_id: expect.any(String)
    });
    // Provider messages stay server-side.
    expect(res.body.message).not.toContain('provider failure');

    const terminals = terminalEvents();
    expect(terminals).toHaveLength(1);
    expect(terminals[0].event).toBe('generation_failed');
    expect(terminals[0].properties).toMatchObject({
      error_code: errorShape.errorCode,
      http_status: expectedStatus,
      outcome: errorShape.code,
      is_terminal: true
    });
    expect(capturedEvents().filter((event) => event.event === 'generation_completed')).toHaveLength(0);
  });

  test('quota denial emits one terminal generation_blocked_no_credits with quota_exhausted', async () => {
    quotaService.reserveGenerationQuota.mockResolvedValueOnce({
      error: 'QUOTA_EXCEEDED',
      status: 402,
      message: 'Quota exceeded',
      payload: { credits_used: 50, remaining_credits: 0, total_limit: 50 }
    });
    const app = buildApp();

    const res = await request(app)
      .post('/api/alt-text')
      .set('X-Site-Key', 'site-hash-1')
      .send({ image: { url: 'https://example.com/img.jpg', width: 1, height: 1 } });
    await flushAsyncEvents();

    expect(res.status).toBe(402);
    expect(res.body.generation_run_id).toEqual(expect.any(String));

    const terminals = terminalEvents();
    expect(terminals).toHaveLength(1);
    expect(terminals[0].event).toBe('generation_blocked_no_credits');
    expect(terminals[0].properties).toMatchObject({
      error_code: 'quota_exhausted',
      http_status: 402,
      outcome: 'QUOTA_EXCEEDED'
    });
    expect(generateAltText).not.toHaveBeenCalled();
  });

  test('unexpected internal exception resolves to one terminal generation_failed with internal_unknown_error (never a second event type)', async () => {
    quotaService.reserveGenerationQuota.mockRejectedValueOnce(new Error('unexpected database explosion'));
    const app = buildApp();

    const res = await request(app)
      .post('/api/alt-text')
      .set('X-Site-Key', 'site-hash-1')
      .send({ image: { url: 'https://example.com/img.jpg', width: 1, height: 1 } });
    await flushAsyncEvents();

    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({
      code: 'INTERNAL_ERROR',
      error_code: 'internal_unknown_error',
      retryable: false,
      generation_run_id: expect.any(String)
    });
    expect(res.body.message).not.toContain('database explosion');

    const terminals = terminalEvents();
    expect(terminals).toHaveLength(1);
    expect(terminals[0].event).toBe('generation_failed');
    expect(terminals[0].properties).toMatchObject({
      error_code: 'internal_unknown_error',
      http_status: 500
    });
    // No generation_failed_unknown-style second terminal event exists.
    const eventNames = capturedEvents().map((event) => event.event);
    expect(eventNames.filter((name) => name.startsWith('generation_'))).toEqual(['generation_failed']);
  });

  test('events never include image contents, prompts or personal data', async () => {
    const app = buildApp();
    await request(app)
      .post('/api/alt-text')
      .set('X-Site-Key', 'site-hash-1')
      .send({
        image: { url: 'https://example.com/img.jpg', width: 1, height: 1 },
        context: { title: 'user-supplied secret context' }
      });
    await flushAsyncEvents();

    const events = capturedEvents();
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      assertNoSensitiveProperties(event);
      expect(JSON.stringify(event)).not.toContain('user-supplied secret context');
    }
  });
});
