jest.mock('../../services/siteQuota', () => ({ finalizeSiteGeneration: jest.fn() }));
jest.mock('../../lib/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
const { finalizeSiteGeneration } = require('../../services/siteQuota');
const { finalizeGenerationQuotaReservation } = require('../../services/quota');
const input = { generationRequestId: 'staging-request', success: false, finalMetadata: { error_code: 'provider_timeout' } };
beforeEach(() => finalizeSiteGeneration.mockReset().mockResolvedValue({ error: null, data: { status: 'released' } }));
test('retries a transient database failure with identical idempotent finalization arguments', async () => {
  finalizeSiteGeneration.mockResolvedValueOnce({ error: { code: '08006', message: 'connection failure' }, status: 503 });
  const result = await finalizeGenerationQuotaReservation({}, input);
  expect(result.error).toBeNull();
  expect(result.data.status).toBe('released');
  expect(finalizeSiteGeneration).toHaveBeenCalledTimes(2);
  expect(finalizeSiteGeneration.mock.calls[0]).toEqual(finalizeSiteGeneration.mock.calls[1]);
});
test('retries a transport exception after an ambiguous RPC response', async () => {
  finalizeSiteGeneration.mockRejectedValueOnce(Object.assign(new Error('connection reset'), { code: 'ECONNRESET' }));
  expect((await finalizeGenerationQuotaReservation({}, input)).error).toBeNull();
  expect(finalizeSiteGeneration).toHaveBeenCalledTimes(2);
});
test('retries HTTP service failures even without a PostgreSQL code', async () => {
  finalizeSiteGeneration.mockResolvedValueOnce({ error: { message: 'service unavailable' }, status: 503 });
  expect((await finalizeGenerationQuotaReservation({}, input)).error).toBeNull();
  expect(finalizeSiteGeneration).toHaveBeenCalledTimes(2);
});
test('persistent failure is returned after three attempts, never reported as success', async () => {
  const error = { code: '08006', message: 'database unavailable' };
  finalizeSiteGeneration.mockResolvedValue({ error, status: 503 });
  expect((await finalizeGenerationQuotaReservation({}, input)).error).toBe(error);
  expect(finalizeSiteGeneration).toHaveBeenCalledTimes(3);
});
test.each(['42501','PGRST202','23503'])('does not retry permanent permission, schema or constraint error %s', async code => {
  finalizeSiteGeneration.mockResolvedValue({ error: { code, message: 'permanent failure' }, status: 400 });
  expect((await finalizeGenerationQuotaReservation({}, input)).error.code).toBe(code);
  expect(finalizeSiteGeneration).toHaveBeenCalledTimes(1);
});
