const { validateLicense, getLimits, sanitizeLicense } = require('../../services/license');

function createSupabaseMock(returnData) {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          single: () => Promise.resolve({ data: returnData, error: returnData ? null : new Error('not found') })
        })
      })
    })
  };
}

describe('license service', () => {
  test('rejects missing license key', async () => {
    const supabase = createSupabaseMock(null);
    const result = await validateLicense(supabase, '');
    expect(result.error).toBe('INVALID_LICENSE');
    expect(result.status).toBe(401);
  });

  test('returns limits by plan', () => {
    expect(getLimits('free').credits).toBe(25);
    expect(getLimits('pro').credits).toBe(1000);
    expect(getLimits('agency').maxSites).toBeNull();
  });

  test('sanitizeLicense strips sensitive fields and keeps public ones', () => {
    const safe = sanitizeLicense({
      id: 'lic-1',
      license_key: 'key-123',
      email: 'owner@example.com',
      plan: 'pro',
      status: 'active',
      max_sites: 1,
      password_hash: '$2a$10$secret',
      password_reset_token: 'reset-secret',
      password_reset_expires: '2026-01-02T00:00:00.000Z',
      stripe_customer_id: 'cus_secret',
      stripe_subscription_id: 'sub_secret'
    });
    expect(safe).toEqual({
      id: 'lic-1',
      license_key: 'key-123',
      email: 'owner@example.com',
      plan: 'pro',
      status: 'active',
      max_sites: 1
    });
  });

  test('sanitizeLicense handles missing license', () => {
    expect(sanitizeLicense(null)).toBeNull();
    expect(sanitizeLicense(undefined)).toBeNull();
  });
});

describe('license lookup failures', () => {
  const db = (data, error) => ({ from: () => ({ select: () => ({ eq: () => ({ single: async () => ({ data, error }) }) }) }) });
  test('missing key remains an authentication error', async () => {
    const result = await validateLicense(db(null, { code: 'PGRST116', details: 'The result contains 0 rows' }), 'missing-key');
    expect(result.status).toBe(401);
    expect(result.code).toBe('INVALID_LICENSE');
  });
  test.each([{ code: '08006' }, { code: 'PGRST116', details: 'The result contains 2 rows' }])('database failure fails closed without invalidating credential: %j', async error => {
    const result = await validateLicense(db(null, error), 'valid-key');
    expect(result.status).toBe(503);
    expect(result.code).toBe('SERVICE_UNAVAILABLE');
    expect(result.license).toBeUndefined();
  });
  test('network exception fails closed with retryable service status', async () => {
    const result = await validateLicense({ from: () => { throw new Error('private connection detail'); } }, 'valid-key');
    expect(result.status).toBe(503);
    expect(result.message).not.toContain('private');
  });
});
