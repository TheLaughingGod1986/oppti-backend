const {
  SOURCE,
  inferSignupPlugin,
  isExcludedEmail,
  pluginFromUsageRow
} = require('../../lib/signupPluginBackfill');
const { run, parseArgs } = require('../../../scripts/backfill-signup-plugin');

describe('signup_plugin backfill rules', () => {
  const usage = (endpoint, feature_type, created_at) => ({ endpoint, feature_type, created_at });

  test('never touches a row that already has signup_plugin', () => {
    expect(inferSignupPlugin({ signup_plugin: 'titles' }, { usage: [usage('api/alt-text', 'alt_text', '2026-01-01')] }))
      .toEqual({ plugin: null, source: null, skipped: 'already_set' });
  });

  test('Auditor-referred accounts are website_auditor regardless of other signals', () => {
    expect(inferSignupPlugin({ signup_source_auditor: true }, { usage: [usage('api/titles/generate', 'title_meta', '2026-01-01')] }))
      .toEqual({ plugin: 'website_auditor', source: SOURCE.AUDITOR });
    expect(inferSignupPlugin({ auditor_finding: 'missing_alt' }, {}).plugin).toBe('website_auditor');
  });

  test('order: first usage, then Stripe, then consented PostHog, then first connection', () => {
    const all = {
      usage: [usage('api/titles/generate', 'title_meta', '2026-03-02'), usage('api/alt-text', 'alt_text', '2026-03-05')],
      stripe: [{ created_at: '2026-03-01', metadata: { plugin_id: 'alt_text' } }],
      posthog: [{ timestamp: '2026-02-01', plugin: 'internal_linking', consented: true }],
      connections: [{ plugin_id: 'alt_text', first_connected_at: '2026-01-01' }]
    };
    expect(inferSignupPlugin({}, all)).toEqual({ plugin: 'titles', source: SOURCE.USAGE });
    expect(inferSignupPlugin({}, { ...all, usage: [] })).toEqual({ plugin: 'alt_text', source: SOURCE.STRIPE });
    expect(inferSignupPlugin({}, { ...all, usage: [], stripe: [] })).toEqual({ plugin: 'internal_linking', source: SOURCE.POSTHOG });
    expect(inferSignupPlugin({}, { connections: all.connections })).toEqual({ plugin: 'alt_text', source: SOURCE.CONNECTION });
    expect(inferSignupPlugin({}, {})).toEqual({ plugin: null, source: null });
  });

  test('PostHog events without consent are ignored', () => {
    expect(inferSignupPlugin({}, { posthog: [{ timestamp: '2026-02-01', plugin: 'titles', consented: false }] }).plugin).toBeNull();
  });

  test('usage plugin follows the endpoint, so a defaulted feature_type cannot hide Titles', () => {
    expect(pluginFromUsageRow({ endpoint: 'api/titles/generate', feature_type: 'alt_text' })).toBe('titles');
    expect(pluginFromUsageRow({ endpoint: 'api/internal-linking/suggest', feature_type: 'alt_text' })).toBe('internal_linking');
    expect(pluginFromUsageRow({ endpoint: null, feature_type: 'title_meta' })).toBe('titles');
    expect(pluginFromUsageRow({ endpoint: 'api/alt-text', feature_type: 'alt_text' })).toBe('alt_text');
  });

  test('test domains are excluded', () => {
    ['a@qa.oppti.dev', 'b@maxxspace.com', 'c@UBERIP.com', 'd@example.invalid'].forEach((e) => expect(isExcludedEmail(e)).toBe(true));
    expect(isExcludedEmail('owner@bakery.co.uk')).toBe(false);
  });

  test('--write is refused; --apply is required to write', () => {
    expect(parseArgs([]).apply).toBe(false);
    expect(parseArgs(['--apply']).apply).toBe(true);
    expect(() => parseArgs(['--write'])).toThrow('--apply');
  });
});

function fakeSupabase(tables) {
  const writes = [];
  function chain(table, mode, payload) {
    const filters = [];
    let window = null;
    const c = {
      select() { return c; },
      not(col, op, val) { filters.push((r) => !(op === 'is' && val === null ? r[col] == null : r[col] === val)); return c; },
      is(col, val) { filters.push((r) => (val === null ? r[col] == null : r[col] === val)); return c; },
      eq(col, val) { filters.push((r) => r[col] === val); return c; },
      in(col, vals) { filters.push((r) => vals.includes(r[col])); return c; },
      order() { return c; },
      range(a, b) { window = [a, b]; return c; },
      then(resolve, reject) {
        let rows = tables[table].filter((r) => filters.every((f) => f(r)));
        if (mode === 'update') {
          rows.forEach((r) => Object.assign(r, payload));
          writes.push({ table, payload, count: rows.length });
          return Promise.resolve({ data: rows.map((r) => ({ id: r.id })), error: null }).then(resolve, reject);
        }
        if (window) rows = rows.slice(window[0], window[1] + 1);
        return Promise.resolve({ data: rows.map((r) => ({ ...r })), error: null }).then(resolve, reject);
      }
    };
    return c;
  }
  return {
    writes,
    from(table) {
      return { select: () => chain(table, 'select'), update: (p) => chain(table, 'update', p) };
    }
  };
}

describe('backfill-signup-plugin script', () => {
  const seed = () => ({
    licenses: [
      { id: 'l1', email: 'one@shop.example', password_hash: 'x', signup_plugin: null, created_at: '2026-03-01' },
      { id: 'l2', email: 'two@shop.example', password_hash: 'x', signup_plugin: null, created_at: '2026-03-02' },
      { id: 'l3', email: 'three@shop.example', password_hash: 'x', signup_plugin: null, created_at: '2026-03-03' },
      { id: 'l4', email: 'qa@qa.oppti.dev', password_hash: 'x', signup_plugin: null, created_at: '2026-03-04' },
      { id: 'l5', email: 'set@shop.example', password_hash: 'x', signup_plugin: 'titles', created_at: '2026-03-05' },
      { id: 'l6', email: 'key-only@shop.example', password_hash: null, signup_plugin: null, created_at: '2026-03-06' },
      { id: 'l7', email: 'aud@shop.example', password_hash: 'x', signup_plugin: null, signup_source_auditor: true, created_at: '2026-03-07' }
    ],
    usage_logs: [
      { license_id: 'l1', endpoint: 'api/titles/generate', feature_type: 'title_meta', created_at: '2026-03-01T10:00:00Z' },
      { license_id: 'l4', endpoint: 'api/alt-text', feature_type: 'alt_text', created_at: '2026-03-04T10:00:00Z' }
    ],
    account_plugin_connections: [
      { license_id: 'l2', plugin_id: 'alt_text', first_connected_at: '2026-03-02T10:00:00Z' }
    ]
  });

  test('dry-run (default) prints counts only and writes nothing', async () => {
    const tables = seed();
    const supabase = fakeSupabase(tables);
    const lines = [];
    const summary = await run({ supabase, log: (l) => lines.push(l) });
    expect(summary).toMatchObject({
      mode: 'dry_run',
      considered: 5,
      excluded: 1,
      inferred: 3,
      left_null: 1,
      by_source: { inferred_first_usage: 1, inferred_first_connection: 1, inferred_auditor_referral: 1 },
      by_plugin: { titles: 1, alt_text: 1, website_auditor: 1 }
    });
    expect(supabase.writes).toHaveLength(0);
    const out = lines.join('\n');
    ['shop.example', 'qa.oppti.dev', 'l1', 'l2', '@'].forEach((s) => expect(out).not.toContain(s));
  });

  test('--apply fills blanks with a source marker and never overwrites', async () => {
    const tables = seed();
    const supabase = fakeSupabase(tables);
    const summary = await run({ supabase, apply: true, log: () => {} });
    expect(summary.written).toBe(3);
    const byId = Object.fromEntries(tables.licenses.map((r) => [r.id, r]));
    expect(byId.l1).toMatchObject({ signup_plugin: 'titles', signup_plugin_source: 'inferred_first_usage' });
    expect(byId.l2).toMatchObject({ signup_plugin: 'alt_text', signup_plugin_source: 'inferred_first_connection' });
    expect(byId.l7).toMatchObject({ signup_plugin: 'website_auditor', signup_plugin_source: 'inferred_auditor_referral' });
    expect(byId.l3.signup_plugin).toBeNull();
    expect(byId.l4.signup_plugin).toBeNull();
    expect(byId.l5).toMatchObject({ signup_plugin: 'titles' });
    expect(byId.l5.signup_plugin_source).toBeUndefined();
    expect(byId.l6.signup_plugin).toBeNull();
  });

  test('Stripe and PostHog exports are used in order when given', async () => {
    const tables = seed();
    const supabase = fakeSupabase(tables);
    const stripe = new Map([['l3', [{ created_at: '2026-03-03', metadata: { plugin_id: 'titles' } }]]]);
    const posthog = new Map([['l3', [{ timestamp: '2026-03-03', plugin: 'alt_text', consented: true }]]]);
    const summary = await run({ supabase, stripe, posthog, log: () => {} });
    expect(summary.by_source.inferred_stripe_checkout).toBe(1);
    expect(summary.steps_skipped).toEqual([]);
  });
});
