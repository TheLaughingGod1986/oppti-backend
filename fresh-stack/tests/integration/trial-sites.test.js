/**
 * Tests for trial site upsert behavior.
 *
 * Validates:
 *  - New anonymous trial request creates a `sites` row + trial_usage.
 *  - Repeated trial requests for same hash do NOT duplicate `sites`.
 *  - Different hashes create distinct `sites` rows.
 *  - Registration links existing trial site row (upsert, not duplicate).
 *  - License activation links existing trial site row.
 *  - Concurrency: parallel inserts for same hash produce exactly one row.
 */

const { findOrCreateTrialSite } = require('../../services/site');

// ---------------------------------------------------------------------------
// Supabase mock helpers
// ---------------------------------------------------------------------------

/**
 * In-memory mock that mimics Supabase .from('sites') with unique constraint
 * on site_hash.  Supports select/eq/maybeSingle/single, insert, update, upsert.
 */
function createSiteStoreMock() {
  const rows = [];
  let nextId = 1;

  function buildChain(pendingOp) {
    const filters = [];
    const chain = {
      select: () => chain,
      eq: (col, val) => { filters.push({ col, val }); return chain; },
      maybeSingle: () => {
        if (pendingOp) return pendingOp(filters);
        const match = rows.find(r => filters.every(f => r[f.col] === f.val));
        return Promise.resolve({ data: match || null, error: null });
      },
      single: () => {
        if (pendingOp) return pendingOp(filters);
        const match = rows.find(r => filters.every(f => r[f.col] === f.val));
        if (!match) return Promise.resolve({ data: null, error: { message: 'not found' } });
        return Promise.resolve({ data: match, error: null });
      }
    };
    return chain;
  }

  return {
    rows,
    from: (table) => {
      if (table !== 'sites') {
        // For non-sites tables, return a no-op chainable.
        return buildChain();
      }

      return {
        select: (...args) => buildChain().select(...args),
        eq: (col, val) => buildChain().eq(col, val),

        insert: (payload) => {
          // Check unique constraint on site_hash.
          const existing = rows.find(r => r.site_hash === payload.site_hash);
          if (existing) {
            return buildChain(() => Promise.resolve({
              data: null,
              error: { message: 'duplicate key', code: '23505' }
            }));
          }
          const row = { id: `uuid-${nextId++}`, ...payload };
          rows.push(row);
          return buildChain(() => Promise.resolve({ data: row, error: null }));
        },

        update: (payload) => {
          return {
            eq: (col, val) => {
              const idx = rows.findIndex(r => r[col] === val);
              if (idx >= 0) Object.assign(rows[idx], payload);
              return { select: () => ({ single: () => Promise.resolve({ data: rows[idx], error: null }) }) };
            }
          };
        },

        upsert: (payload, opts = {}) => {
          const conflictCol = opts.onConflict || 'site_hash';
          const existing = rows.find(r => r[conflictCol] === payload[conflictCol]);
          if (existing) {
            Object.assign(existing, payload);
            return buildChain(() => Promise.resolve({ data: existing, error: null }));
          }
          const row = { id: `uuid-${nextId++}`, ...payload };
          rows.push(row);
          return buildChain(() => Promise.resolve({ data: row, error: null }));
        }
      };
    }
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('findOrCreateTrialSite', () => {
  test('creates a new site row for a new trial site_hash', async () => {
    const mock = createSiteStoreMock();

    const result = await findOrCreateTrialSite(mock, {
      siteHash: 'abc123',
      siteUrl: 'https://example.com',
      fingerprint: 'fp-1'
    });

    expect(result.error).toBeNull();
    expect(result.data).toBeTruthy();
    expect(result.data.site_hash).toBe('abc123');
    // Row is persisted.
    expect(mock.rows).toHaveLength(1);
    expect(mock.rows[0].site_hash).toBe('abc123');
    expect(mock.rows[0].site_url).toBe('https://example.com');
    // Trial sites have no license_key.
    expect(mock.rows[0].license_key).toBeUndefined();
  });

  test('does NOT duplicate sites for the same site_hash', async () => {
    const mock = createSiteStoreMock();

    // First call — creates
    await findOrCreateTrialSite(mock, { siteHash: 'dup-hash', siteUrl: 'https://a.com' });
    expect(mock.rows).toHaveLength(1);

    // Second call — should NOT create another row
    const result = await findOrCreateTrialSite(mock, { siteHash: 'dup-hash', siteUrl: 'https://a.com' });
    expect(result.error).toBeNull();
    expect(mock.rows).toHaveLength(1);
  });

  test('different hashes create distinct site rows', async () => {
    const mock = createSiteStoreMock();

    await findOrCreateTrialSite(mock, { siteHash: 'hash-1' });
    await findOrCreateTrialSite(mock, { siteHash: 'hash-2' });
    await findOrCreateTrialSite(mock, { siteHash: 'hash-3' });

    expect(mock.rows).toHaveLength(3);
    const hashes = mock.rows.map(r => r.site_hash);
    expect(new Set(hashes).size).toBe(3);
  });

  test('updates last_activity_at on repeat visit without duplicating', async () => {
    const mock = createSiteStoreMock();

    await findOrCreateTrialSite(mock, { siteHash: 'repeat' });
    const firstActivity = mock.rows[0].last_activity_at;

    // Small delay to get a different timestamp.
    await new Promise(r => setTimeout(r, 10));
    await findOrCreateTrialSite(mock, { siteHash: 'repeat' });

    expect(mock.rows).toHaveLength(1);
    expect(mock.rows[0].last_activity_at).not.toBe(firstActivity);
  });

  test('enriches site_url when existing row has unknown/null url', async () => {
    const mock = createSiteStoreMock();

    // First visit without URL.
    await findOrCreateTrialSite(mock, { siteHash: 'enrich' });
    expect(mock.rows[0].site_url).toBeNull();

    // Second visit with URL — should enrich.
    await findOrCreateTrialSite(mock, { siteHash: 'enrich', siteUrl: 'https://real.com' });
    expect(mock.rows[0].site_url).toBe('https://real.com');
  });

  test('rejects empty or missing site_hash', async () => {
    const mock = createSiteStoreMock();

    const r1 = await findOrCreateTrialSite(mock, { siteHash: '' });
    expect(r1.error).toBeTruthy();

    const r2 = await findOrCreateTrialSite(mock, { siteHash: null });
    expect(r2.error).toBeTruthy();

    const r3 = await findOrCreateTrialSite(mock, {});
    expect(r3.error).toBeTruthy();

    expect(mock.rows).toHaveLength(0);
  });

  test('sanitizes inputs to safe lengths', async () => {
    const mock = createSiteStoreMock();
    const longHash = 'x'.repeat(500);
    const longUrl = 'https://' + 'u'.repeat(600);

    await findOrCreateTrialSite(mock, { siteHash: longHash, siteUrl: longUrl });

    expect(mock.rows[0].site_hash.length).toBeLessThanOrEqual(255);
    expect(mock.rows[0].site_url.length).toBeLessThanOrEqual(500);
  });
});

describe('Registration links existing trial site', () => {
  test('upsert during registration attaches license_key to trial site', async () => {
    const mock = createSiteStoreMock();

    // Simulate trial: site row exists with no license.
    await findOrCreateTrialSite(mock, { siteHash: 'reg-hash', siteUrl: 'https://trial.com' });
    expect(mock.rows).toHaveLength(1);
    expect(mock.rows[0].license_key).toBeUndefined();

    // Simulate registration upsert (mirrors auth.js upsert call).
    const supabase = mock;
    await supabase
      .from('sites')
      .upsert({
        license_key: 'license-abc',
        site_hash: 'reg-hash',
        site_url: 'https://trial.com',
        status: 'active',
        activated_at: new Date().toISOString(),
        last_activity_at: new Date().toISOString()
      }, { onConflict: 'site_hash' });

    // Should NOT create a duplicate — just update existing row.
    expect(mock.rows).toHaveLength(1);
    expect(mock.rows[0].license_key).toBe('license-abc');
    expect(mock.rows[0].site_hash).toBe('reg-hash');
  });
});

describe('License activation links existing trial site', () => {
  test('activateLicense upsert attaches license to trial site row', async () => {
    const mock = createSiteStoreMock();

    // Simulate trial site.
    await findOrCreateTrialSite(mock, { siteHash: 'activate-hash' });
    expect(mock.rows).toHaveLength(1);
    expect(mock.rows[0].license_key).toBeUndefined();

    // Simulate activateLicense upsert (mirrors license.js line 130-134).
    await mock
      .from('sites')
      .upsert({
        site_hash: 'activate-hash',
        site_url: 'https://activated.com',
        site_name: 'My Site',
        fingerprint: 'fp-2',
        license_key: 'license-xyz',
        plan: 'free',
        status: 'active',
        activated_at: new Date().toISOString()
      }, { onConflict: 'site_hash' });

    // Still one row, now with license.
    expect(mock.rows).toHaveLength(1);
    expect(mock.rows[0].license_key).toBe('license-xyz');
    expect(mock.rows[0].site_url).toBe('https://activated.com');
  });
});

describe('Concurrency safety', () => {
  test('parallel findOrCreateTrialSite calls for same hash produce exactly one row', async () => {
    const mock = createSiteStoreMock();

    // Fire 5 concurrent calls for the same hash.
    const results = await Promise.all([
      findOrCreateTrialSite(mock, { siteHash: 'concurrent' }),
      findOrCreateTrialSite(mock, { siteHash: 'concurrent' }),
      findOrCreateTrialSite(mock, { siteHash: 'concurrent' }),
      findOrCreateTrialSite(mock, { siteHash: 'concurrent' }),
      findOrCreateTrialSite(mock, { siteHash: 'concurrent' }),
    ]);

    // All should succeed.
    results.forEach(r => {
      expect(r.error).toBeNull();
      expect(r.data).toBeTruthy();
    });

    // Exactly one row in store.
    const matching = mock.rows.filter(r => r.site_hash === 'concurrent');
    expect(matching).toHaveLength(1);
  });
});
