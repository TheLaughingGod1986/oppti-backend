const { claimIdempotencyKey } = require('../../services/idempotencyClaims');

function fakeSupabase({ insertError = null, existing = null, updateRows = [] } = {}) {
  const calls = [];
  const builder = (op) => {
    const c = {
      eq: () => c,
      select: () => c,
      maybeSingle: () => Promise.resolve({ data: existing, error: null }),
      then: (r, j) => Promise.resolve(op === 'update' ? { data: updateRows, error: null } : { data: null, error: null }).then(r, j)
    };
    return c;
  };
  return {
    calls,
    from: () => ({
      insert: (row) => { calls.push(['insert', row]); return Promise.resolve({ error: insertError }); },
      select: () => builder('select'),
      update: (row) => { calls.push(['update', row]); return builder('update'); },
      delete: () => builder('delete')
    })
  };
}

describe('claimIdempotencyKey', () => {
  test('fresh key is claimed', async () => {
    const sb = fakeSupabase();
    await expect(claimIdempotencyKey(sb, { scope: 's', key: 'k' })).resolves.toEqual({ claimed: true });
  });

  test('unique violation on a live claim is not claimed', async () => {
    const existing = { status: 'in_progress', expires_at: new Date(Date.now() + 60000).toISOString() };
    const sb = fakeSupabase({ insertError: { code: '23505' }, existing });
    const r = await claimIdempotencyKey(sb, { scope: 's', key: 'k' });
    expect(r.claimed).toBe(false);
    expect(r.existing).toBe(existing);
  });

  test('expired claim from a crashed owner is taken over atomically', async () => {
    const existing = { status: 'in_progress', expires_at: new Date(Date.now() - 1000).toISOString() };
    const sb = fakeSupabase({ insertError: { code: '23505' }, existing, updateRows: [{ idempotency_key: 'k' }] });
    const r = await claimIdempotencyKey(sb, { scope: 's', key: 'k' });
    expect(r).toEqual({ claimed: true, takeover: true });
  });

  test('missing claims table fails open (pre-migration deploy)', async () => {
    const sb = fakeSupabase({ insertError: { code: '42P01', message: 'relation does not exist' } });
    await expect(claimIdempotencyKey(sb, { scope: 's', key: 'k' })).resolves.toEqual({ claimed: true, degraded: true });
  });
});
