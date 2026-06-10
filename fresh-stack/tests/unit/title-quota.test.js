// Titles share the alt-text credit wallet. titleQuota.js is a thin adapter
// over services/siteQuota.js, so these tests assert it delegates to the shared
// reserve/finalize/status functions (tagging feature_type='title_meta') rather
// than maintaining a separate title pool.
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
  TITLES_FEATURE_TYPE,
  reserveTitleGenerationQuota,
  finalizeTitleGenerationQuota,
  getTitleQuotaStatus,
  buildTitleRequestFingerprint
} = require('../../services/titleQuota');

const SITE = { id: 'site-uuid', site_hash: 'hash-abc', license_key: 'lic-test' };

beforeEach(() => {
  jest.clearAllMocks();
});

describe('reserveTitleGenerationQuota', () => {
  test('reserves from the SHARED wallet, tagging feature_type=title_meta', async () => {
    reserveSiteCredits.mockResolvedValue({
      error: null,
      site: SITE,
      reservation: { ok: true, generation_request_id: 'gen-1', remaining_credits: 48, total_limit: 50 }
    });

    const result = await reserveTitleGenerationQuota({ rpc: jest.fn() }, {
      licenseKey: 'lic-test',
      siteIdentity: { siteHash: 'hash-abc' },
      creditsNeeded: 2,
      idempotencyKey: 'idem-1',
      requestFingerprint: 'fp-1',
      requestMetadata: { endpoint: 'api/titles/generate' }
    });

    expect(reserveSiteCredits).toHaveBeenCalledTimes(1);
    const [, args] = reserveSiteCredits.mock.calls[0];
    expect(args.creditsNeeded).toBe(2); // title (1) + meta (1)
    expect(args.quotaMode).toBe('site');
    expect(args.idempotencyKey).toBe('idem-1');
    expect(args.requestMetadata.feature_type).toBe(TITLES_FEATURE_TYPE);
    expect(args.requestMetadata.endpoint).toBe('api/titles/generate');
    // Passthrough of the shared-pool result.
    expect(result.error).toBeNull();
    expect(result.reservation.remaining_credits).toBe(48);
    expect(result.site).toEqual(SITE);
  });

  test('defaults to 2 credits when creditsNeeded is omitted', async () => {
    reserveSiteCredits.mockResolvedValue({ error: null, site: SITE, reservation: { ok: true } });
    await reserveTitleGenerationQuota({ rpc: jest.fn() }, {
      licenseKey: 'lic-test',
      siteIdentity: { siteHash: 'hash-abc' }
    });
    expect(reserveSiteCredits.mock.calls[0][1].creditsNeeded).toBe(2);
  });

  test('passes shared-wallet quota errors straight through', async () => {
    reserveSiteCredits.mockResolvedValue({
      error: 'QUOTA_EXCEEDED',
      status: 402,
      message: 'Quota exceeded',
      payload: { remaining_credits: 0, total_limit: 50 }
    });

    const result = await reserveTitleGenerationQuota({ rpc: jest.fn() }, {
      licenseKey: 'lic-test',
      siteIdentity: { siteHash: 'h' }
    });

    expect(result.error).toBe('QUOTA_EXCEEDED');
    expect(result.status).toBe(402);
    expect(result.payload.remaining_credits).toBe(0);
  });
});

describe('finalizeTitleGenerationQuota', () => {
  test('delegates to the shared finalize with feature_type metadata', async () => {
    finalizeSiteGeneration.mockResolvedValue({ data: { ok: true, status: 'succeeded' }, error: null });

    const result = await finalizeTitleGenerationQuota({ rpc: jest.fn() }, {
      generationRequestId: 'gen-1',
      success: true,
      finalMetadata: { model_used: 'gpt-4o-mini' }
    });

    expect(finalizeSiteGeneration).toHaveBeenCalledTimes(1);
    const [, args] = finalizeSiteGeneration.mock.calls[0];
    expect(args.generationRequestId).toBe('gen-1');
    expect(args.success).toBe(true);
    expect(args.finalMetadata.feature_type).toBe(TITLES_FEATURE_TYPE);
    expect(args.finalMetadata.model_used).toBe('gpt-4o-mini');
    expect(result.data.status).toBe('succeeded');
  });
});

describe('getTitleQuotaStatus', () => {
  test('reshapes the SHARED balance into a titles entitlement snapshot', async () => {
    getSiteQuotaStatus.mockResolvedValue({
      error: null,
      site: SITE,
      plan_type: 'free',
      credits_used: 12,
      credits_remaining: 38,
      total_limit: 50,
      reset_date: '2026-07-01T00:00:00.000Z'
    });

    const status = await getTitleQuotaStatus({ rpc: jest.fn() }, {
      licenseKey: 'lic-test',
      siteIdentity: { siteHash: 'hash-abc' }
    });

    expect(status.feature_type).toBe(TITLES_FEATURE_TYPE);
    expect(status.credits_used).toBe(12);
    expect(status.credits_remaining).toBe(38); // same number alt-text would report
    expect(status.total_limit).toBe(50);
    expect(status.plan).toBe('free');
    expect(status.source).toBe('site_quotas_shared');
  });

  test('passes through resolution errors', async () => {
    getSiteQuotaStatus.mockResolvedValue({ error: 'SITE_NOT_FOUND', status: 404, message: 'nope' });
    const status = await getTitleQuotaStatus({ rpc: jest.fn() }, { siteIdentity: {} });
    expect(status.error).toBe('SITE_NOT_FOUND');
    expect(status.status).toBe(404);
  });
});

describe('buildTitleRequestFingerprint', () => {
  test('builds a deterministic fingerprint from page + options', () => {
    const fp = buildTitleRequestFingerprint({
      siteKey: 'site-1',
      userInfo: { user_id: 'wp-1' },
      page: { url: '/about', h1: 'About' },
      options: { brand_name: 'X' },
      previous: null
    });
    expect(typeof fp).toBe('string');
    expect(fp.length).toBeGreaterThan(0);
  });
});
