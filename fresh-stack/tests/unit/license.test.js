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
    expect(getLimits('free').credits).toBe(15);
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
