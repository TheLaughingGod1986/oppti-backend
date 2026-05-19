/**
 * Unit tests for the backward-compatible identity cleanup.
 *
 * Covers:
 *  - recordUsage resolves license_id from license_key when licenseId omitted
 *  - recordUsage never writes a licenses.id into user_id
 *  - recordUsage preserves null/null for anonymous trial payloads
 *  - recordUsage flags internal/TasteWP telemetry via is_internal
 *  - isInternalTelemetryHost classification matrix
 *  - syncLegacySitePointers writes license_id on the sites row
 */

jest.mock('../../lib/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  getRecentEntries: jest.fn().mockReturnValue([]),
  clearRecentEntries: jest.fn()
}));

jest.mock('../../../src/services/loops', () => ({
  trackGenerationMilestone: jest.fn().mockResolvedValue(undefined),
  trackCreditsExhausted: jest.fn().mockResolvedValue(undefined),
  trackAccountCreated: jest.fn().mockResolvedValue(undefined),
  trackPlanUpgraded: jest.fn().mockResolvedValue(undefined)
}));

const { recordUsage } = require('../../services/usage');
const { syncLegacySitePointers } = require('../../services/siteQuota');
const { isInternalTelemetryHost } = require('../../lib/siteIdentity');

const LICENSE_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_UUID = '22222222-2222-4222-8222-222222222222';

function createUsageMock({ licenseId = null } = {}) {
  const captured = {};
  const supabase = {
    from(table) {
      if (table === 'licenses') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () =>
                Promise.resolve({ data: licenseId ? { id: licenseId } : null, error: null }),
              single: () => Promise.resolve({ data: null, error: null })
            })
          })
        };
      }
      if (table === 'usage_logs') {
        return {
          insert: (payload) => {
            captured.payload = payload;
            return { select: () => Promise.resolve({ data: [{ id: 'usage-row-1' }], error: null }) };
          },
          select: () => ({ eq: () => ({ gte: () => Promise.resolve({ data: [], error: null }) }) })
        };
      }
      return { insert: () => ({ select: () => Promise.resolve({ data: [], error: null }) }) };
    }
  };
  return { supabase, captured };
}

function createSyncMock() {
  const captured = {};
  const supabase = {
    from(table) {
      return {
        update: (payload) => {
          captured[table] = payload;
          return { eq: () => Promise.resolve({ data: null, error: null }) };
        }
      };
    }
  };
  return { supabase, captured };
}

describe('recordUsage identity cleanup', () => {
  test('resolves license_id from license_key when licenseId is omitted', async () => {
    const { supabase, captured } = createUsageMock({ licenseId: LICENSE_ID });

    await recordUsage(supabase, {
      licenseKey: 'lic-key-abc',
      siteHash: 'site-hash-1',
      siteUrl: 'https://realcustomer.com',
      creditsUsed: 1
    });

    expect(captured.payload.license_id).toBe(LICENSE_ID);
    expect(captured.payload.user_id).toBeNull();
  });

  test('never writes a licenses.id into user_id (drops user_id == license_id)', async () => {
    const { supabase, captured } = createUsageMock({ licenseId: LICENSE_ID });

    await recordUsage(supabase, {
      licenseKey: 'lic-key-abc',
      licenseId: LICENSE_ID,
      userId: LICENSE_ID,
      siteHash: 'site-hash-1',
      siteUrl: 'https://realcustomer.com',
      creditsUsed: 1
    });

    expect(captured.payload.license_id).toBe(LICENSE_ID);
    expect(captured.payload.user_id).toBeNull();
  });

  test('preserves null license_id and null user_id for anonymous trial', async () => {
    const { supabase, captured } = createUsageMock({ licenseId: null });

    await recordUsage(supabase, {
      licenseKey: null,
      licenseId: null,
      userId: null,
      siteHash: 'trial-site-hash',
      siteUrl: 'https://sometrialsite.com',
      isTrial: true,
      authState: 'guest_trial',
      creditsUsed: 1
    });

    expect(captured.payload.license_id).toBeNull();
    expect(captured.payload.user_id).toBeNull();
    expect(captured.payload.is_trial).toBe(true);
  });

  test('flags is_internal for TasteWP telemetry, not for real domains', async () => {
    const internal = createUsageMock({ licenseId: LICENSE_ID });
    await recordUsage(internal.supabase, {
      licenseKey: 'lic-key-abc',
      siteHash: 'h1',
      siteUrl: 'https://abc123.tastewp.com',
      creditsUsed: 1
    });
    expect(internal.captured.payload.is_internal).toBe(true);

    const real = createUsageMock({ licenseId: LICENSE_ID });
    await recordUsage(real.supabase, {
      licenseKey: 'lic-key-abc',
      siteHash: 'h2',
      siteUrl: 'https://acme-store.com',
      creditsUsed: 1
    });
    expect(real.captured.payload.is_internal).toBe(false);
  });
});

describe('isInternalTelemetryHost', () => {
  test.each([
    ['http://localhost:8080', true],
    ['https://abc.tastewp.com', true],
    ['https://foo.example.com', true],
    ['https://beepbeepaiaudit.io', true],
    ['http://127.0.0.1', true],
    ['https://acme.com', false],
    ['https://customer-store.co.uk', false]
  ])('%s -> internal=%s', (siteUrl, expected) => {
    expect(isInternalTelemetryHost({ siteUrl })).toBe(expected);
  });

  test('returns false for empty input', () => {
    expect(isInternalTelemetryHost({})).toBe(false);
    expect(isInternalTelemetryHost({ domain: null, siteUrl: null })).toBe(false);
  });
});

describe('syncLegacySitePointers', () => {
  test('writes license_id onto the sites row alongside license_key', async () => {
    const { supabase, captured } = createSyncMock();

    await syncLegacySitePointers(supabase, {
      site: { id: 'site-uuid-1', site_hash: 'hash-1', license_key: null, owner_user_id: null },
      account: { id: LICENSE_ID, license_key: 'lic-key-abc' }
    });

    expect(captured.sites).toBeDefined();
    expect(captured.sites.license_id).toBe(LICENSE_ID);
    expect(captured.sites.license_key).toBe('lic-key-abc');
    expect(captured.sites.owner_user_id).toBe(LICENSE_ID);
  });

  test('does not link a foreign site owned by a different license', async () => {
    const { supabase, captured } = createSyncMock();

    await syncLegacySitePointers(supabase, {
      site: { id: 'site-uuid-2', site_hash: 'hash-2', license_key: 'someone-elses-key', owner_user_id: OTHER_UUID },
      account: { id: LICENSE_ID, license_key: 'lic-key-abc' }
    });

    expect(captured.sites).toBeUndefined();
  });
});
