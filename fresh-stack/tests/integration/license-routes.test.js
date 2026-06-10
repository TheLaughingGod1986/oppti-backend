/**
 * Route-level tests for /license endpoints, focused on ensuring license
 * responses never expose sensitive columns (password_hash, reset tokens,
 * stripe ids) to clients holding only a license key.
 */

const express = require('express');
const request = require('supertest');
const { createLicenseRouter } = require('../../routes/license');

const SENSITIVE_FIELDS = [
  'password_hash',
  'password_reset_token',
  'password_reset_expires',
  'stripe_customer_id',
  'stripe_subscription_id'
];

const FULL_LICENSE_ROW = {
  id: 'lic-1',
  license_key: 'key-123',
  email: 'owner@example.com',
  plan: 'pro',
  status: 'active',
  max_sites: 1,
  billing_anchor_date: '2026-01-01T00:00:00.000Z',
  billing_cycle: 'monthly',
  billing_day_of_month: 1,
  created_at: '2025-12-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
  password_hash: '$2a$10$secret',
  password_reset_token: 'reset-secret',
  password_reset_expires: '2026-01-02T00:00:00.000Z',
  stripe_customer_id: 'cus_secret',
  stripe_subscription_id: 'sub_secret'
};

function createSupabaseMock(licenseRow) {
  return {
    from: (table) => {
      if (table === 'licenses') {
        return {
          select: () => ({
            eq: () => ({
              single: () => Promise.resolve({ data: licenseRow, error: licenseRow ? null : new Error('not found') }),
              maybeSingle: () => Promise.resolve({ data: licenseRow, error: null })
            })
          })
        };
      }
      if (table === 'sites') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => Promise.resolve({ data: [], error: null }),
              maybeSingle: () => Promise.resolve({ data: null, error: null })
            })
          }),
          upsert: (payload) => ({
            select: () => ({
              single: () => Promise.resolve({ data: payload, error: null })
            })
          }),
          update: () => ({
            eq: () => ({
              eq: () => Promise.resolve({ error: null })
            })
          })
        };
      }
      return {};
    }
  };
}

function buildApp(licenseRow) {
  const app = express();
  app.use(express.json());
  app.use('/license', createLicenseRouter({ supabase: createSupabaseMock(licenseRow) }));
  return app;
}

function expectNoSensitiveFields(obj) {
  SENSITIVE_FIELDS.forEach((field) => {
    expect(obj).not.toHaveProperty(field);
  });
}

describe('license routes response sanitisation', () => {
  test('POST /license/validate returns only public license fields', async () => {
    const res = await request(buildApp(FULL_LICENSE_ROW))
      .post('/license/validate')
      .send({ license_key: 'key-123' });

    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(true);
    expect(res.body.license.email).toBe('owner@example.com');
    expect(res.body.license.plan).toBe('pro');
    expect(res.body.license.license_key).toBe('key-123');
    expectNoSensitiveFields(res.body.license);
  });

  test('POST /license/activate does not leak sensitive license fields', async () => {
    const res = await request(buildApp(FULL_LICENSE_ROW))
      .post('/license/activate')
      .send({ license_key: 'key-123', site_id: 'site-1', site_url: 'https://example.com' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.organization.plan).toBe('pro');
    expect(res.body.license.email).toBe('owner@example.com');
    expectNoSensitiveFields(res.body.license);
  });

  test('POST /license/transfer does not leak sensitive license fields', async () => {
    const res = await request(buildApp(FULL_LICENSE_ROW))
      .post('/license/transfer')
      .send({
        license_key: 'key-123',
        old_site_id: 'site-1',
        new_site_id: 'site-2',
        new_site_url: 'https://new.example.com'
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.license.email).toBe('owner@example.com');
    expectNoSensitiveFields(res.body.license);
  });

  test('POST /license/deactivate with expired license returns error without license row', async () => {
    const res = await request(buildApp({ ...FULL_LICENSE_ROW, status: 'expired' }))
      .post('/license/deactivate')
      .send({ license_key: 'key-123', site_id: 'site-1' });

    expect(res.status).toBe(410);
    expect(res.body.error).toBe('LICENSE_EXPIRED');
    expect(res.body.license).toBeUndefined();
  });

  test('POST /license/transfer with suspended license returns error without license row', async () => {
    const res = await request(buildApp({ ...FULL_LICENSE_ROW, status: 'suspended' }))
      .post('/license/transfer')
      .send({ license_key: 'key-123', old_site_id: 'site-1', new_site_id: 'site-2' });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('LICENSE_SUSPENDED');
    expect(res.body.license).toBeUndefined();
  });
});
