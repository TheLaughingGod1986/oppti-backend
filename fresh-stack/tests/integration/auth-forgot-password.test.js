/**
 * POST /auth/forgot-password and /auth/reset-password security (QA review, 22 Oct 2026).
 *
 * QA cases: hostile siteUrl, failed send and unknown email all return the same
 * 200 body with no link or token, in production and non-production.
 * Test addresses use @qa.oppti.dev only.
 */
const express = require('express');
const request = require('supertest');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

process.env.JWT_SECRET = 'test-jwt-secret';

jest.mock('../../../src/services/loops', () => ({
  trackAccountCreated: jest.fn().mockResolvedValue(undefined),
  trackPluginConnected: jest.fn().mockResolvedValue(undefined),
  isLoopsSkippedEmail: jest.fn().mockReturnValue(true)
}));

jest.mock('../../lib/posthog', () => ({
  identifyServerUser: jest.fn().mockResolvedValue({ ok: true }),
  captureServerEvent: jest.fn().mockResolvedValue({ ok: true }),
  aliasServerUser: jest.fn().mockResolvedValue({ ok: true })
}));

const mockEmail = {
  sendPasswordResetEmail: jest.fn(),
  isAvailable: jest.fn()
};
jest.mock('../../lib/email', () => ({
  sendPasswordResetEmail: (...args) => mockEmail.sendPasswordResetEmail(...args),
  isAvailable: (...args) => mockEmail.isAvailable(...args)
}));

const logger = require('../../lib/logger');
const { createAuthRouter, hashResetToken } = require('../../routes/auth');

const sha256 = (value) => crypto.createHash('sha256').update(value, 'utf8').digest('hex');
const tokenFromLink = (link) => new URL(link).searchParams.get('token');

const KNOWN_EMAIL = 'reset-owner@qa.oppti.dev';
const UNKNOWN_EMAIL = 'nobody-here@qa.oppti.dev';
const HOSTILE_SITE_URL = 'https://attacker.example/wp-admin/upload.php?page=bbai';
const GENERIC_BODY = {
  success: true,
  message: 'If an account exists with this email, you will receive password reset instructions'
};

function createSupabaseMock() {
  const licenses = [
    { id: 'lic-1', email: KNOWN_EMAIL, password_hash: 'old', password_reset_token: null, password_reset_expires: null }
  ];
  const updates = [];

  function from(table) {
    if (table !== 'licenses') throw new Error(`unexpected table ${table}`);
    const filters = [];
    let pendingUpdate = null;
    const builder = {
      select() { return builder; },
      eq(column, value) {
        filters.push([column, value]);
        if (pendingUpdate) {
          const rows = licenses.filter((row) => filters.every(([c, v]) => row[c] === v));
          rows.forEach((row) => Object.assign(row, pendingUpdate));
          updates.push({ filters: [...filters], values: pendingUpdate });
          return Promise.resolve({ data: null, error: null });
        }
        return builder;
      },
      update(values) { pendingUpdate = values; return builder; },
      maybeSingle() {
        const rows = licenses.filter((row) => filters.every(([c, v]) => row[c] === v));
        return Promise.resolve({ data: rows[0] ? { ...rows[0] } : null, error: null });
      }
    };
    return builder;
  }

  return { from, licenses, updates };
}

function buildApp(supabase) {
  const app = express();
  app.use(express.json());
  app.use('/auth', createAuthRouter({ supabase }));
  return app;
}

async function waitFor(check, timeoutMs = 1000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for background work');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function expectNoSecrets(res, supabase) {
  const raw = JSON.stringify(res.body) + (res.text || '');
  expect(res.status).toBe(200);
  expect(res.body).toEqual(GENERIC_BODY);
  expect(raw).not.toMatch(/token|resetLink|reset-password|https?:\/\//i);
  for (const row of supabase.licenses) {
    if (row.password_reset_token) expect(raw).not.toContain(row.password_reset_token);
  }
}

const savedEnv = { NODE_ENV: process.env.NODE_ENV, PASSWORD_RESET_BASE_URL: process.env.PASSWORD_RESET_BASE_URL };
let logSpies;

beforeEach(() => {
  mockEmail.sendPasswordResetEmail.mockReset().mockResolvedValue({ success: true, messageId: 'em_1' });
  mockEmail.isAvailable.mockReset().mockReturnValue(true);
  delete process.env.PASSWORD_RESET_BASE_URL;
  logSpies = ['info', 'warn', 'error'].map((level) => jest.spyOn(logger, level).mockImplementation(() => {}));
});

afterEach(() => {
  logSpies.forEach((spy) => spy.mockRestore());
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

function allLogText() {
  return JSON.stringify(logSpies.map((spy) => spy.mock.calls));
}

describe.each(['production', 'development', 'test'])('forgot-password (NODE_ENV=%s)', (nodeEnv) => {
  beforeEach(() => { process.env.NODE_ENV = nodeEnv; });

  test('hostile siteUrl is ignored: link uses the fixed oppti.dev base, response has no link or token', async () => {
    const supabase = createSupabaseMock();
    const res = await request(buildApp(supabase))
      .post('/auth/forgot-password')
      .send({ email: KNOWN_EMAIL, siteUrl: HOSTILE_SITE_URL });

    expectNoSecrets(res, supabase);
    await waitFor(() => mockEmail.sendPasswordResetEmail.mock.calls.length === 1);

    const [to, link] = mockEmail.sendPasswordResetEmail.mock.calls[0];
    const stored = supabase.licenses[0].password_reset_token;
    const token = tokenFromLink(link);
    expect(to).toBe(KNOWN_EMAIL);
    expect(token).toMatch(/^[0-9a-f-]{36}$/);
    expect(link).toBe(`https://oppti.dev/reset-password?token=${token}`);
    // Only the sha256 digest is stored, never the emailed token.
    expect(stored).toMatch(/^[0-9a-f]{64}$/);
    expect(stored).toBe(sha256(token));
    expect(stored).not.toContain(token);
    expect(link).not.toMatch(/attacker|localhost|8080|wp-admin/);
    expectNoSecrets(res, supabase);
  });

  test('a siteUrl that is not a URL is ignored too (no 400 that would differ)', async () => {
    const supabase = createSupabaseMock();
    const res = await request(buildApp(supabase))
      .post('/auth/forgot-password')
      .send({ email: KNOWN_EMAIL, siteUrl: 'javascript:alert(1)' });
    expectNoSecrets(res, supabase);
  });

  test('failed send: same body, no link or token, failure logged with the email masked', async () => {
    mockEmail.sendPasswordResetEmail.mockResolvedValue({ success: false, error: `Resend rejected ${KNOWN_EMAIL}` });
    const supabase = createSupabaseMock();
    const res = await request(buildApp(supabase))
      .post('/auth/forgot-password')
      .send({ email: KNOWN_EMAIL, siteUrl: HOSTILE_SITE_URL });

    expectNoSecrets(res, supabase);
    await waitFor(() => allLogText().includes('Failed to send password reset email'));
    const logs = allLogText();
    expect(logs).not.toContain(KNOWN_EMAIL);
    expect(logs).toContain('r***@qa.oppti.dev');
    expect(logs).not.toContain(supabase.licenses[0].password_reset_token);
  });

  test('send throws: same body, no link or token', async () => {
    mockEmail.sendPasswordResetEmail.mockRejectedValue(new Error('network down'));
    const supabase = createSupabaseMock();
    const res = await request(buildApp(supabase))
      .post('/auth/forgot-password')
      .send({ email: KNOWN_EMAIL });
    expectNoSecrets(res, supabase);
    await waitFor(() => allLogText().includes('Failed to send password reset email'));
  });

  test('email service not configured: same body, no link or token, nothing sent', async () => {
    mockEmail.isAvailable.mockReturnValue(false);
    const supabase = createSupabaseMock();
    const res = await request(buildApp(supabase))
      .post('/auth/forgot-password')
      .send({ email: KNOWN_EMAIL, siteUrl: HOSTILE_SITE_URL });
    expectNoSecrets(res, supabase);
    await waitFor(() => allLogText().includes('email service not configured'));
    expect(mockEmail.sendPasswordResetEmail).not.toHaveBeenCalled();
    expect(allLogText()).not.toContain(KNOWN_EMAIL);
  });

  test('unknown email: identical status and body, no token written, nothing sent', async () => {
    const supabase = createSupabaseMock();
    const app = buildApp(supabase);
    const known = await request(app).post('/auth/forgot-password').send({ email: KNOWN_EMAIL, siteUrl: HOSTILE_SITE_URL });
    await waitFor(() => mockEmail.sendPasswordResetEmail.mock.calls.length === 1);
    const unknown = await request(app).post('/auth/forgot-password').send({ email: UNKNOWN_EMAIL, siteUrl: HOSTILE_SITE_URL });

    expectNoSecrets(unknown, supabase);
    expect(unknown.status).toBe(known.status);
    expect(unknown.text).toBe(known.text);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mockEmail.sendPasswordResetEmail).toHaveBeenCalledTimes(1);
    expect(supabase.updates).toHaveLength(1);
  });

  test('no database: same body, no link or token, nothing sent', async () => {
    const res = await request(buildApp(null))
      .post('/auth/forgot-password')
      .send({ email: KNOWN_EMAIL, siteUrl: HOSTILE_SITE_URL });
    expect(res.status).toBe(200);
    expect(res.body).toEqual(GENERIC_BODY);
    expect(JSON.stringify(res.body)).not.toMatch(/token|http/i);
    expect(mockEmail.sendPasswordResetEmail).not.toHaveBeenCalled();
  });
});

describe('forgot-password timing and config', () => {
  test('responds before the email send finishes, so a slow send does not reveal the account', async () => {
    let release;
    mockEmail.sendPasswordResetEmail.mockImplementation(() => new Promise((resolve) => { release = resolve; }));
    const supabase = createSupabaseMock();
    const res = await request(buildApp(supabase)).post('/auth/forgot-password').send({ email: KNOWN_EMAIL });
    expectNoSecrets(res, supabase);
    await waitFor(() => typeof release === 'function');
    release({ success: true });
  });

  test('PASSWORD_RESET_BASE_URL overrides the base; a non-https value falls back to https://oppti.dev', async () => {
    process.env.PASSWORD_RESET_BASE_URL = 'https://staging.oppti.dev/ignored/path';
    let supabase = createSupabaseMock();
    await request(buildApp(supabase)).post('/auth/forgot-password').send({ email: KNOWN_EMAIL, siteUrl: HOSTILE_SITE_URL });
    await waitFor(() => mockEmail.sendPasswordResetEmail.mock.calls.length === 1);
    expect(mockEmail.sendPasswordResetEmail.mock.calls[0][1]).toMatch(/^https:\/\/staging\.oppti\.dev\/reset-password\?token=/);

    process.env.PASSWORD_RESET_BASE_URL = 'http://localhost:8080';
    supabase = createSupabaseMock();
    await request(buildApp(supabase)).post('/auth/forgot-password').send({ email: KNOWN_EMAIL });
    await waitFor(() => mockEmail.sendPasswordResetEmail.mock.calls.length === 2);
    expect(mockEmail.sendPasswordResetEmail.mock.calls[1][1]).toMatch(/^https:\/\/oppti\.dev\/reset-password\?token=/);
  });

  test('invalid email is a 400 that does not depend on whether an account exists', async () => {
    const res = await request(buildApp(createSupabaseMock())).post('/auth/forgot-password').send({ email: 'not-an-email' });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toMatch(/token|http/i);
  });
});

describe('reset-password', () => {
  async function issueToken(supabase) {
    await request(buildApp(supabase)).post('/auth/forgot-password').send({ email: KNOWN_EMAIL });
    await waitFor(() => mockEmail.sendPasswordResetEmail.mock.calls.length === 1);
    return tokenFromLink(mockEmail.sendPasswordResetEmail.mock.calls[0][1]);
  }

  test('hashed token round trip: emailed token resets once; the stored digest itself is useless', async () => {
    const supabase = createSupabaseMock();
    const token = await issueToken(supabase);
    const stored = supabase.licenses[0].password_reset_token;
    expect(hashResetToken(token)).toBe(stored);
    const app = buildApp(supabase);

    // Someone who read the DB value cannot use it as the token.
    const leaked = await request(app).post('/auth/reset-password').send({ token: stored, password: 'stolen-password-1' });
    expect(leaked.status).toBe(400);
    const leakedWithEmail = await request(app).post('/auth/reset-password').send({ email: KNOWN_EMAIL, token: stored, password: 'stolen-password-1' });
    expect(leakedWithEmail.status).toBe(400);
    expect(supabase.licenses[0].password_hash).toBe('old');

    const ok = await request(app).post('/auth/reset-password').send({ token, password: 'new-password-789' });
    expect(ok.status).toBe(200);
    expect(await bcrypt.compare('new-password-789', supabase.licenses[0].password_hash)).toBe(true);

    const again = await request(app).post('/auth/reset-password').send({ email: KNOWN_EMAIL, token, password: 'another-password-1' });
    expect(again.status).toBe(400);
  });

  test('a token stored in plain text before this release no longer matches (expires within 1h anyway)', async () => {
    const supabase = createSupabaseMock();
    const legacy = '3f2b8c1e-0d4a-4c47-9a51-7b3e2d1f0a99';
    supabase.licenses[0].password_reset_token = legacy;
    supabase.licenses[0].password_reset_expires = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    const res = await request(buildApp(supabase)).post('/auth/reset-password').send({ email: KNOWN_EMAIL, token: legacy, password: 'new-password-123' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_TOKEN');
  });

  test('token-only request (oppti.dev reset page) sets the password and clears the token', async () => {
    const supabase = createSupabaseMock();
    const token = await issueToken(supabase);
    const res = await request(buildApp(supabase)).post('/auth/reset-password').send({ token, password: 'new-password-123' });
    expect(res.status).toBe(200);
    expect(await bcrypt.compare('new-password-123', supabase.licenses[0].password_hash)).toBe(true);
    expect(supabase.licenses[0].password_reset_token).toBeNull();
  });

  test('email + token request (plugin form) still works', async () => {
    const supabase = createSupabaseMock();
    const token = await issueToken(supabase);
    const res = await request(buildApp(supabase)).post('/auth/reset-password').send({ email: KNOWN_EMAIL, token, newPassword: 'new-password-456' });
    expect(res.status).toBe(200);
  });

  test('wrong token and unknown email get the same 400', async () => {
    const supabase = createSupabaseMock();
    await issueToken(supabase);
    const app = buildApp(supabase);
    const wrong = await request(app).post('/auth/reset-password').send({ email: KNOWN_EMAIL, token: 'wrong-token', password: 'new-password-123' });
    const unknown = await request(app).post('/auth/reset-password').send({ email: UNKNOWN_EMAIL, token: 'wrong-token', password: 'new-password-123' });
    const tokenOnly = await request(app).post('/auth/reset-password').send({ token: 'wrong-token', password: 'new-password-123' });
    expect(wrong.status).toBe(400);
    expect(unknown.text).toBe(wrong.text);
    expect(tokenOnly.text).toBe(wrong.text);
    expect(supabase.licenses[0].password_hash).toBe('old');
  });

  test('validation failure never logs the new password or token', async () => {
    await request(buildApp(createSupabaseMock())).post('/auth/reset-password').send({ token: 'secret-token-value', password: 'short' });
    const logs = allLogText();
    expect(logs).not.toContain('secret-token-value');
    expect(logs).not.toContain('short');
  });
});
