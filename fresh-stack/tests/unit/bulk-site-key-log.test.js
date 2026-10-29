/**
 * Bulk alt-text items: the accounting trace and the ledger-skipped line log
 * has_site_key only, never the job's site key or a stored site_hash. No logger call carries the raw site key or any
 * 8-character slice of the licence key.
 */
jest.mock('../../lib/openai', () => ({
  generateAltText: jest.fn().mockResolvedValue({
    altText: 'mock alt',
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    meta: { modelUsed: 'mock', generation_time_ms: 1 }
  })
}));
jest.mock('../../services/quota', () => ({
  reserveGenerationQuota: jest.fn(),
  finalizeGenerationQuotaReservation: jest.fn().mockResolvedValue({ error: null, data: { status: 'succeeded' } }),
  getQuotaStatus: jest.fn().mockResolvedValue({ plan_type: 'pro', credits_used: 1, credits_remaining: 9, total_limit: 10 })
}));
jest.mock('../../services/usage', () => ({ recordUsage: jest.fn().mockResolvedValue({ error: null, data: { id: 'usage_1' } }) }));
jest.mock('../../services/imageAltState', () => ({ upsertGeneratedImageAltState: jest.fn().mockResolvedValue({ error: null }) }));
jest.mock('../../services/usageAttribution', () => ({ resolveUsageAttributionUserId: jest.fn().mockResolvedValue({ userId: null, source: 'none' }) }));

const logger = require('../../lib/logger');
const quotaService = require('../../services/quota');
const { processLicensedBulkItem } = require('../../services/bulkAltTextProcessor');
const { expectNoCredentialSlices } = require('../helpers/credentialSlices');

const RAW_SITE_KEY = 'qa-raw-site-key-secret-0001';
const KEY = 'QA-FAKE-LICENSE-KEY-0001';

function supabase() {
  const c = { select: () => c, eq: () => c, maybeSingle: () => Promise.resolve({ data: { id: 'lic_row_1' }, error: null }) };
  return { from: () => c };
}

describe('bulk item logs: no raw site key', () => {
  let spies;
  beforeEach(() => {
    jest.clearAllMocks();
    spies = ['warn', 'info', 'debug', 'error'].map((level) => jest.spyOn(logger, level).mockImplementation(() => {}));
  });
  afterEach(() => spies.forEach((spy) => spy.mockRestore()));
  const calls = () => spies.flatMap((spy) => spy.mock.calls);
  const lines = (message) => calls().filter(([m]) => m === message);

  async function run(site, error = null) {
    quotaService.reserveGenerationQuota.mockResolvedValue(error
      ? { error, message: 'denied', status: 402, site }
      : { error: null, reservation: { generation_request_id: 'gr_1', quota_source: 'site_quota' }, site });
    return processLicensedBulkItem({
      supabase: supabase(),
      licenseKey: KEY,
      siteKey: RAW_SITE_KEY,
      userInfo: { user_id: '1' },
      image: { url: 'https://example.com/img.jpg', width: 1, height: 1 },
      itemContext: {},
      jobId: 'job_1',
      itemIndex: 0,
      clientItemId: 'item_1'
    });
  }

  test('site row without an id (stored hash = sent key): ledger_write_skipped and accounting trace log has_site_key only', async () => {
    await run({ site_hash: RAW_SITE_KEY, license_key: KEY });
    const skipped = lines('[image-state] ledger_write_skipped');
    expect(skipped.length).toBe(1);
    expect(skipped[0][1]).toEqual(expect.objectContaining({ has_site_key: true }));
    const trace = lines('[usage] generation_accounting_trace');
    expect(trace.length).toBe(1);
    expect(trace[0][1]).toEqual(expect.objectContaining({ has_site_key: true }));
    expectNoCredentialSlices(calls(), [RAW_SITE_KEY, KEY]);
  });

  test('no site row at all: the raw job key is not logged', async () => {
    await run(null);
    expect(lines('[image-state] ledger_write_skipped')[0][1]).toEqual(expect.objectContaining({ has_site_key: true }));
    expectNoCredentialSlices(calls(), [RAW_SITE_KEY, KEY]);
  });

  test('quota denied: accounting trace carries no raw site key', async () => {
    await run({ site_hash: RAW_SITE_KEY }, 'QUOTA_EXCEEDED');
    expect(lines('[usage] generation_accounting_trace')[0][1]).toEqual(expect.objectContaining({ has_site_key: true }));
    expectNoCredentialSlices(calls(), [RAW_SITE_KEY, KEY]);
  });

  test('a stored hash that differs from the job key is not logged either', async () => {
    await run({ site_hash: 'stored-hash-abc', license_key: KEY });
    expect(lines('[image-state] ledger_write_skipped')[0][1]).toEqual(expect.objectContaining({ has_site_key: true }));
    expectNoCredentialSlices(calls(), [RAW_SITE_KEY, 'stored-hash-abc', KEY]);
  });
});
