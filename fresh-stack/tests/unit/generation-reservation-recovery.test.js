jest.mock('../../services/siteQuota', () => ({ finalizeSiteGeneration: jest.fn() }));
const { finalizeSiteGeneration } = require('../../services/siteQuota');
const { recoverStaleGenerationReservations, STALE_AFTER_MS, RECOVERABLE_ENDPOINTS } = require('../../services/generationReservationRecovery');
function database(rows, error = null) {
  const query = {};
  for (const name of ['select','eq','lt','in','order']) query[name] = jest.fn(() => query);
  query.limit = jest.fn().mockResolvedValue({ data: rows, error });
  return { db: { from: jest.fn(() => query), rpc: jest.fn() }, query };
}
beforeEach(() => finalizeSiteGeneration.mockReset().mockResolvedValue({ data: { ok: true, status: 'released' }, error: null }));
test('only expired known provider reservations are queried in bounded batches', async () => {
  const {db,query}=database([{id:'orphan'}]);const now=Date.parse('2026-10-27T10:00:00Z');
  expect(await recoverStaleGenerationReservations(db,{now})).toEqual({scanned:1,released:1,failed:0});
  expect(query.eq).toHaveBeenCalledWith('status','reserved');
  expect(query.lt).toHaveBeenCalledWith('created_at',new Date(now-STALE_AFTER_MS).toISOString());
  expect(query.in).toHaveBeenCalledWith('metadata->>endpoint',RECOVERABLE_ENDPOINTS);
  expect(query.limit).toHaveBeenCalledWith(100);
  expect(finalizeSiteGeneration).toHaveBeenCalledWith(db,expect.objectContaining({generationRequestId:'orphan',success:false}));
});
test('settled successful generation is never treated as a release', async () => {
  const {db}=database([{id:'settled'}]);finalizeSiteGeneration.mockResolvedValue({data:{ok:true,status:'succeeded'},error:null});
  expect((await recoverStaleGenerationReservations(db)).released).toBe(0);
});
test('database outage retains durable rows and reports incomplete recovery', async () => {
  const {db}=database([{id:'orphan'}]);finalizeSiteGeneration.mockResolvedValue({error:{code:'08006'}});
  expect(await recoverStaleGenerationReservations(db)).toEqual({scanned:1,released:0,failed:1});
});
test('failed enumeration never claims successful reconciliation', async () => {
  const error={code:'08006'}, {db}=database(null,error);
  expect((await recoverStaleGenerationReservations(db)).error).toBe(error);
  expect(finalizeSiteGeneration).not.toHaveBeenCalled();
});
test('empty recovery has no accounting side effects', async () => {
  const {db}=database([]);expect(await recoverStaleGenerationReservations(db)).toEqual({scanned:0,released:0,failed:0});
  expect(finalizeSiteGeneration).not.toHaveBeenCalled();
});
