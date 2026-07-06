const { getOptimizerAudit } = require('../../services/optimizerAudit');

/* Minimal Supabase stub: supports the select-one read and the update-back
 * chain used by getOptimizerAudit's stale-reconcile path. */
function makeSupabase(row, onUpdate) {
  return {
    from() {
      return {
        // read chain: select().eq().maybeSingle()
        select() { return this; },
        eq() { return this; },
        maybeSingle() { return Promise.resolve({ data: row, error: null }); },
        // write-back chain: update().eq().eq() -> thenable
        update(patch) {
          if (onUpdate) onUpdate(patch);
          const chain = { eq() { return chain; }, then(res) { return Promise.resolve({ error: null }).then(res); } };
          return chain;
        }
      };
    }
  };
}

const UUID = '11111111-1111-1111-1111-111111111111';

describe('getOptimizerAudit — stale reconcile', () => {
  it('marks a long-running row as interrupted', async () => {
    let updated = null;
    const stale = { id: UUID, site_hash: 's', site_url: 'https://x.com', status: 'running',
      created_at: new Date(Date.now() - 10 * 60 * 1000).toISOString(), result_json: null, error_code: null };
    const supabase = makeSupabase(stale, (patch) => { updated = patch; });

    const res = await getOptimizerAudit(UUID, { supabase });
    expect(res.status).toBe('failed');
    expect(res.errorCode).toBe('AUDIT_INTERRUPTED');
    expect(updated).toMatchObject({ status: 'failed', error_code: 'AUDIT_INTERRUPTED' });
  });

  it('leaves a recently-started running row alone', async () => {
    let updated = null;
    const fresh = { id: UUID, site_hash: 's', site_url: 'https://x.com', status: 'running',
      created_at: new Date(Date.now() - 5 * 1000).toISOString(), result_json: null, error_code: null };
    const supabase = makeSupabase(fresh, (patch) => { updated = patch; });

    const res = await getOptimizerAudit(UUID, { supabase });
    expect(res.status).toBe('running');
    expect(updated).toBeNull();
  });

  it('passes a completed row through untouched', async () => {
    const done = { id: UUID, site_hash: 's', site_url: 'https://x.com', status: 'completed',
      created_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(), result_json: { overallScore: 88 }, error_code: null };
    const res = await getOptimizerAudit(UUID, { supabase: makeSupabase(done) });
    expect(res.status).toBe('completed');
    expect(res.result.overallScore).toBe(88);
  });
});
