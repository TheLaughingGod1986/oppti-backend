const {
  claimIdempotencyKey, sweepExpiredClaims, maybeSweepExpiredClaims, resetSweepStateForTests, DEFAULT_CLAIM_TTL_MS
} = require('../../services/idempotencyClaims');

function fakeSupabase(rows) {
  const calls = [];
  const from = () => {
    let op = null; let payload = null; let lt = null;
    const c = {
      insert: (p) => { op = 'insert'; payload = p; return c; },
      delete: () => { op = 'delete'; return c; },
      lt: (col, v) => { lt = [col, v]; return c; },
      then: (r, j) => {
        let res = { data: null, error: null };
        if (op === 'delete' && lt) {
          calls.push({ op: 'sweep', cutoff: lt[1] });
          for (const [k, row] of rows) if (new Date(row.expires_at) < new Date(lt[1])) rows.delete(k);
        } else if (op === 'insert') {
          const k = `${payload.scope}|${payload.idempotency_key}`;
          if (rows.has(k)) res = { data: null, error: { code: '23505', message: 'duplicate key' } };
          else rows.set(k, { ...payload });
        }
        return Promise.resolve(res).then(r, j);
      }
    };
    return c;
  };
  return { from, calls };
}

const iso = (ms) => new Date(ms).toISOString();
const NOW = Date.parse('2026-10-12T12:00:00Z');

beforeEach(() => resetSweepStateForTests());

test('sweep deletes only rows expired longer than the 1h grace', async () => {
  const rows = new Map([
    ['s|old', { expires_at: iso(NOW - 2 * 3600e3) }],
    ['s|recent', { expires_at: iso(NOW - 10 * 60e3) }],
    ['s|live', { expires_at: iso(NOW + 60e3) }]
  ]);
  const sb = fakeSupabase(rows);
  await expect(sweepExpiredClaims(sb, { now: NOW })).resolves.toBe(true);
  expect([...rows.keys()].sort()).toEqual(['s|live', 's|recent']);
});

test('claim triggers at most one sweep per interval', async () => {
  const rows = new Map([['s|old', { expires_at: iso(NOW - 2 * 3600e3) }]]);
  const sb = fakeSupabase(rows);
  await claimIdempotencyKey(sb, { scope: 's', key: 'a', now: NOW });
  await claimIdempotencyKey(sb, { scope: 's', key: 'b', now: NOW + 1000 });
  await new Promise((r) => setImmediate(r));
  expect(sb.calls.filter((c) => c.op === 'sweep')).toHaveLength(1);
  expect(rows.has('s|old')).toBe(false);
  expect(rows.has('s|a')).toBe(true);
  expect(maybeSweepExpiredClaims(sb, NOW + 11 * 60e3)).not.toBeNull();
});

test('a failing sweep never blocks the claim', async () => {
  const sb = { from: () => {
    const c = { insert: () => c, delete: () => c, lt: () => Promise.reject(new Error('db down')), then: (r, j) => Promise.resolve({ data: null, error: null }).then(r, j) };
    return c;
  } };
  await expect(claimIdempotencyKey(sb, { scope: 's', key: 'x', now: NOW })).resolves.toEqual({ claimed: true });
});

test('claim TTL is 2 minutes', () => {
  expect(DEFAULT_CLAIM_TTL_MS).toBe(120000);
});
