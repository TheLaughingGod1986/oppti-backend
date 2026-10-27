jest.mock('../../lib/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
const { finalizeSiteGeneration } = require('../../services/siteQuota');
const rpc = jest.fn();
const db = { rpc };
const input = { generationRequestId: 'staging-request', success: false, finalMetadata: { error_code: 'provider_timeout' } };
beforeEach(() => rpc.mockReset().mockResolvedValue({ error: null, data: { status: 'released' } }));
test('retries a transient database failure with identical idempotent finalization arguments', async () => {
  rpc.mockResolvedValueOnce({ error: { code: '08006', message: 'connection failure' }, status: 503 });
  const result = await finalizeSiteGeneration(db, input);
  expect(result.error).toBeNull();
  expect(result.data.status).toBe('released');
  expect(rpc).toHaveBeenCalledTimes(2);
  expect(rpc.mock.calls[0]).toEqual(rpc.mock.calls[1]);
});
test('retries a transport exception after an ambiguous RPC response', async () => {
  rpc.mockRejectedValueOnce(Object.assign(new Error('connection reset'), { code: 'ECONNRESET' }));
  expect((await finalizeSiteGeneration(db, input)).error).toBeNull();
  expect(rpc).toHaveBeenCalledTimes(2);
});
test('retries HTTP service failures even without a PostgreSQL code', async () => {
  rpc.mockResolvedValueOnce({ error: { message: 'service unavailable' }, status: 503 });
  expect((await finalizeSiteGeneration(db, input)).error).toBeNull();
  expect(rpc).toHaveBeenCalledTimes(2);
});
test('persistent failure is returned after three attempts, never reported as success', async () => {
  const error = { code: '08006', message: 'database unavailable' };
  rpc.mockResolvedValue({ error, status: 503 });
  expect((await finalizeSiteGeneration(db, input)).error).toBe(error);
  expect(rpc).toHaveBeenCalledTimes(3);
});
test.each(['42501','PGRST202','23503'])('does not retry permanent permission, schema or constraint error %s', async code => {
  rpc.mockResolvedValue({ error: { code, message: 'permanent failure' }, status: 400 });
  expect((await finalizeSiteGeneration(db, input)).error.code).toBe(code);
  expect(rpc).toHaveBeenCalledTimes(1);
});
