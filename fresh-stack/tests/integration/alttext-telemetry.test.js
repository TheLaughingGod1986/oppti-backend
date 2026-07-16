const express = require('express');
const request = require('supertest');
const sharp = require('sharp');
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

// Corrupt AVIF: valid 'ftypavif' magic bytes, garbage payload. Passes
// format detection but fails to decode.
const CORRUPT_AVIF_B64 = Buffer.concat([
  Buffer.from([0x00, 0x00, 0x00, 0x1c]),
  Buffer.from('ftypavif'),
  Buffer.alloc(2048, 1)
]).toString('base64');

// Real AVIF fixtures (the format that caused the 15 July 2026 incident:
// 5 images retried 3x each by the client after the backend returned 500).
// Noise content keeps the encoded size realistic so the payload passes the
// existing minimum-size validation guard.
async function makeRealAvifB64(seed) {
  const width = 64 + seed;
  const height = 48;
  const raw = Buffer.alloc(width * height * 3);
  for (let i = 0; i < raw.length; i += 1) {
    raw[i] = (i * (seed + 7) * 31) % 256;
  }
  const avif = await sharp(raw, { raw: { width, height, channels: 3 } })
    .avif({ quality: 70 })
    .toBuffer();
  return avif.toString('base64');
}

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
  expect(serialized).not.toContain(CORRUPT_AVIF_B64.slice(0, 40));
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

  test('incident regression: 5 real AVIF images convert to WebP and succeed — no unsupported-image errors, quota once each (incident repro)', async () => {
    const app = buildApp();
    const fixtures = await Promise.all([1, 2, 3, 4, 5].map((seed) => makeRealAvifB64(seed)));

    const responses = [];
    for (const [index, base64] of fixtures.entries()) {
      responses.push(await request(app)
        .post('/api/alt-text')
        .set('X-Site-Key', 'site-hash-1')
        .set('X-Generation-Run-ID', `run-avif-${index}`)
        .send({ image: { base64, filename: `incident-${index}.avif`, width: 65 + index, height: 48 } }));
    }
    await flushAsyncEvents();

    for (const res of responses) {
      expect(res.status).toBe(200);
      expect(res.body.altText).toBe('mock alt');
    }

    // The provider was called exactly once per image and received genuine
    // WebP bytes with the WebP mime — never AVIF, never relabeled bytes.
    expect(generateAltText).toHaveBeenCalledTimes(5);
    for (const [{ image }] of generateAltText.mock.calls) {
      expect(image.mime_type).toBe('image/webp');
      const sent = Buffer.from(image.base64, 'base64');
      expect(sent.slice(0, 4).toString('latin1')).toBe('RIFF');
      expect(sent.slice(8, 12).toString('latin1')).toBe('WEBP');
      const decoded = await sharp(sent).metadata();
      expect(decoded.format).toBe('webp');
    }

    // Quota reserved exactly once per logical generation.
    expect(quotaService.reserveGenerationQuota).toHaveBeenCalledTimes(5);

    // One terminal completion per request, recording the conversion.
    const terminals = terminalEvents();
    expect(terminals).toHaveLength(5);
    for (const event of terminals) {
      expect(event.event).toBe('generation_completed');
      expect(event.properties).toMatchObject({
        original_format: 'avif',
        provider_format: 'webp',
        image_converted: true,
        error_code: null
      });
      expect(event.properties.conversion_duration_ms).toEqual(expect.any(Number));
      assertNoSensitiveProperties(event);
    }
  });

  test('corrupt AVIF batch fails as terminal non-retryable 400s without reserving quota or calling the provider', async () => {
    const app = buildApp();

    // Simulate the plugin retrying a corrupt image 3 times: every attempt
    // is a cheap, terminal 400 — no provider call, no quota reservation,
    // and no 5xx that invites more retries.
    const responses = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      responses.push(await request(app)
        .post('/api/alt-text')
        .set('X-Site-Key', 'site-hash-1')
        .set('X-Generation-Run-ID', 'run-avif-corrupt')
        .set('X-Generation-Attempt', String(attempt))
        .send({ image: { base64: CORRUPT_AVIF_B64, filename: 'Laundry.avif', width: 10, height: 10 } }));
    }
    await flushAsyncEvents();

    for (const res of responses) {
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({
        success: false,
        code: 'image_decode_failed',
        error_code: 'image_decode_failed',
        generation_run_id: 'run-avif-corrupt',
        retryable: false
      });
      expect(res.body.message).toMatch(/could not read this image/i);
    }
    expect(generateAltText).not.toHaveBeenCalled();
    expect(quotaService.reserveGenerationQuota).not.toHaveBeenCalled();

    const terminals = terminalEvents();
    expect(terminals).toHaveLength(3); // one per HTTP request
    for (const event of terminals) {
      expect(event.event).toBe('generation_failed');
      expect(event.properties).toMatchObject({
        generation_run_id: 'run-avif-corrupt',
        error_code: 'image_decode_failed',
        http_status: 400,
        retryable: false
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
