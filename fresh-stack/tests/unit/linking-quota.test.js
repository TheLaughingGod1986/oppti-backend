// Internal linking shares the alt-text/titles credit wallet. linkingQuota.js
// is a thin adapter over services/siteQuota.js, so these tests assert it
// delegates to the shared reserve/finalize/status functions (tagging
// feature_type='internal_linking') rather than maintaining a separate pool.
jest.mock('../../services/siteQuota', () => ({
  reserveSiteCredits: jest.fn(),
  finalizeSiteGeneration: jest.fn(),
  getSiteQuotaStatus: jest.fn(),
  hashRequestFingerprint: jest.fn(() => 'fp-deadbeef')
}));

const {
  reserveSiteCredits,
  finalizeSiteGeneration,
  getSiteQuotaStatus
} = require('../../services/siteQuota');
const {
  LINKING_FEATURE_TYPE,
  reserveLinkingGenerationQuota,
  finalizeLinkingGenerationQuota,
  getLinkingQuotaStatus,
  buildLinkingRequestFingerprint
} = require('../../services/linkingQuota');

const SITE = { id: 'site-uuid', site_hash: 'hash-abc', license_key: 'lic-test' };

beforeEach(() => {
  jest.clearAllMocks();
});

describe('reserveLinkingGenerationQuota', () => {
  test('reserves from the SHARED wallet, tagging feature_type=internal_linking', async () => {
    reserveSiteCredits.mockResolvedValue({
      error: null,
      site: SITE,
      reservation: { ok: true, generation_request_id: 'gen-1', remaining_credits: 48, total_limit: 50 }
    });

    const result = await reserveLinkingGenerationQuota({ rpc: jest.fn() }, {
      licenseKey: 'lic-test',
      siteIdentity: { siteHash: 'hash-abc' },
      creditsNeeded: 1,
      idempotencyKey: 'idem-1',
      requestFingerprint: 'fp-1',
      requestMetadata: { endpoint: 'api/linking/opportunities' }
    });

    expect(reserveSiteCredits).toHaveBeenCalledTimes(1);
    const [, args] = reserveSiteCredits.mock.calls[0];
    expect(args.creditsNeeded).toBe(1);
    expect(args.quotaMode).toBe('site');
    expect(args.requestMetadata.feature_type).toBe(LINKING_FEATURE_TYPE);
    expect(result.error).toBeNull();
    expect(result.reservation.remaining_credits).toBe(48);
  });

  test('passes shared-wallet quota errors straight through', async () => {
    reserveSiteCredits.mockResolvedValue({
      error: 'QUOTA_EXCEEDED',
      status: 402,
      message: 'Quota exceeded',
      payload: { remaining_credits: 0, total_limit: 50 }
    });

    const result = await reserveLinkingGenerationQuota({ rpc: jest.fn() }, {
      licenseKey: 'lic-test',
      siteIdentity: { siteHash: 'h' }
    });

    expect(result.error).toBe('QUOTA_EXCEEDED');
    expect(result.status).toBe(402);
  });
});

describe('finalizeLinkingGenerationQuota', () => {
  test('delegates to the shared finalize with feature_type metadata', async () => {
    finalizeSiteGeneration.mockResolvedValue({ data: { ok: true, status: 'succeeded' }, error: null });

    const result = await finalizeLinkingGenerationQuota({ rpc: jest.fn() }, {
      generationRequestId: 'gen-1',
      success: true,
      finalMetadata: { model_used: 'gpt-4o-mini' }
    });

    const [, args] = finalizeSiteGeneration.mock.calls[0];
    expect(args.finalMetadata.feature_type).toBe(LINKING_FEATURE_TYPE);
    expect(result.data.status).toBe('succeeded');
  });
});

describe('getLinkingQuotaStatus', () => {
  test('reshapes the SHARED balance into a linking entitlement snapshot', async () => {
    getSiteQuotaStatus.mockResolvedValue({
      error: null,
      site: SITE,
      plan_type: 'free',
      credits_used: 12,
      credits_remaining: 38,
      total_limit: 50,
      reset_date: '2026-08-01T00:00:00.000Z',
      usage_by_feature: { internal_linking: 2, alt_text: 10 }
    });

    const status = await getLinkingQuotaStatus({ rpc: jest.fn() }, {
      licenseKey: 'lic-test',
      siteIdentity: { siteHash: 'hash-abc' }
    });

    expect(status.feature_type).toBe(LINKING_FEATURE_TYPE);
    expect(status.credits_remaining).toBe(38);
    expect(status.usage_by_feature).toEqual({ internal_linking: 2, alt_text: 10 });
    expect(status.source).toBe('site_quotas_shared');
  });
});

describe('buildLinkingRequestFingerprint', () => {
  test('builds a deterministic fingerprint from targets + sources', () => {
    const fp = buildLinkingRequestFingerprint({
      siteKey: 'site-1',
      userInfo: { user_id: 'wp-1' },
      targets: [{ id: 2 }, { id: 1 }],
      sources: [{ id: 9 }],
      maxSuggestions: 5
    });
    expect(typeof fp).toBe('string');
    expect(fp.length).toBeGreaterThan(0);
  });
});
