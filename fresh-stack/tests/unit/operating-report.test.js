const { productOf, exclusion, deduplicate, calculate, windows } = require('../../lib/operatingReport');
const props = { plugin_slug: 'opptiai-titles', product: 'title_meta', environment: 'production', telemetry_consent: true, traffic_origin: 'customer_action', site_install_id: 'install-a' };
const event = (name, timestamp, extra = {}) => ({ event: name, timestamp, properties: { ...props, operation_id: timestamp, ...extra } });
const options = { start: '2026-10-01T00:00:00Z', end: '2026-10-20T00:00:00Z', product: 'title_meta', coverage: { productionVerified: true, successComplete: true, activationComplete: true, historyComplete: true } };
test.each([['beepbeep-ai-alt-text-generator', 'alt_text'], ['opptiai-titles', 'title_meta'], ['opptiai-internal-linking', 'internal_linking']])('attributes %s without relying on event name', (slug, product) => expect(productOf({ plugin_slug: slug })).toBe(product));
test('ambiguous generic successes remain Unclassified', () => expect(productOf({ event: 'generation_completed' })).toBe('Unclassified'));
test('conflicting explicit attribution is Unclassified', () => expect(productOf({ plugin_slug: 'opptiai-titles', product: 'alt_text' })).toBe('Unclassified'));
test.each([{ environment: 'staging' }, { is_test: true }, { is_internal: 'true' }, { site_host: 'demo.tastewp.com' }, { site_url: 'https://example.com/page' }, { traffic_type: 'Automation' }, { telemetry_consent: false }, { traffic_origin: undefined }])('fails closed for exclusions %j', extra => expect(exclusion({ ...props, ...extra })).not.toBeNull());
test('privacy-safe Internal Linking needs no hostname', () => expect(exclusion({ ...props, plugin_slug: 'opptiai-internal-linking' })).toBeNull());
test('deduplicates operation retries but preserves repeated generation on same item', () => {
  const a = event('title_meta_generated', '2026-10-02T00:00:00Z', { attachment_id: 1 });
  const b = event('title_meta_generated', '2026-10-03T00:00:00Z', { attachment_id: 1 });
  expect(deduplicate([a, a, b])).toHaveLength(2);
});
test('unverified delivery never becomes zero', () => expect(calculate([], { ...options, coverage: {} }).successes).toMatchObject({ value: null, status: 'U' }));
test('verified empty observation confirms zero counts but cannot create a denominator', () => {
  const r = calculate([], options);
  expect(r.successes.value).toBe(0);
  expect(r.activation_conversion.status).toBe('U');
  expect(r.seven_day_retention.status).toBe('U');
});
test('calculates linked timing, mature conversion, repeat and day-7 retention', () => {
  const r = calculate([
    event('plugin_activated', '2026-10-01T00:00:00Z'),
    event('title_meta_generated', '2026-10-01T00:01:00Z'),
    event('title_meta_generated', '2026-10-08T00:02:00Z')
  ], options);
  expect(r.activation_conversion).toMatchObject({ value: 1, numerator: 1, denominator: 1 });
  expect(r.median_time_to_first_value_seconds.value).toBe(60);
  expect(r.repeat_success_identities.value).toBe(1);
  expect(r.seven_day_retention.value).toBe(1);
});
test('unlinked success cannot convert an activation', () => {
  const r = calculate([event('plugin_activated', '2026-10-01T00:00:00Z'), event('title_meta_generated', '2026-10-02T00:00:00Z', { site_install_id: 'install-b' })], options);
  expect(r.activation_conversion.value).toBe(0);
  expect(r.median_time_to_first_value_seconds.status).toBe('U');
});
test('missing success identity or dedup key makes totals unavailable', () => {
  const r = calculate([event('title_meta_generated', '2026-10-02T00:00:00Z', { site_install_id: undefined })], options);
  expect(r.successes.status).toBe('U');
});
test('partial history blocks lifetime first and lifecycle claims', () => {
  const r = calculate([event('title_meta_generated', '2026-10-02T00:00:00Z')], { ...options, coverage: { ...options.coverage, historyComplete: false } });
  expect(r.lifecycle.status).toBe('U');
  expect(r.repeat_success_identities.status).toBe('U');
});
test('immature cohorts never enter retention denominator', () => {
  const r = calculate([event('title_meta_generated', '2026-10-19T00:00:00Z')], options);
  expect(r.seven_day_retention.status).toBe('U');
});
test('failed write and generic backend completion are not persisted value', () => {
  const r = calculate([event('generation_completed', '2026-10-02T00:00:00Z'), event('title_meta_generated', '2026-10-03T00:00:00Z', { success: false })], options);
  expect(r.successes.value).toBe(0);
});
test('lifecycle separates new, prior-period returning and older resurrected installs', () => {
  const r = calculate([
    event('title_meta_generated', '2026-10-02T00:00:00Z', { site_install_id: 'new' }),
    event('title_meta_generated', '2026-09-20T00:00:00Z', { site_install_id: 'returning' }),
    event('title_meta_generated', '2026-10-02T00:00:00Z', { site_install_id: 'returning' }),
    event('title_meta_generated', '2026-09-01T00:00:00Z', { site_install_id: 'resurrected' }),
    event('title_meta_generated', '2026-10-02T00:00:00Z', { site_install_id: 'resurrected' })
  ], options);
  expect(r.lifecycle.value).toEqual({ New: 1, Returning: 1, Resurrected: 1 });
});
test('uses half-open exact UTC windows and excludes future rows', () => {
  const w = windows('2026-10-27T08:55:00Z');
  expect(w.latest24h.start).toBe(w.preceding24h.end);
  expect(calculate([event('title_meta_generated', options.end)], options).successes.value).toBe(0);
});
const { deliveryQuery, cohortExportQuery } = require('../../lib/operatingReport/queries');
test('delivery query excludes aggregate downloads and separates attribution gaps', () => {
  const sql = deliveryQuery(options.end);
  expect(sql).toContain("'Unclassified'");
  expect(sql).toContain("event NOT IN ('wporg_downloads_daily','wporg_stats_snapshot')");
  expect(sql).toContain('preceding24h');
  expect(sql).toContain('automated_transport');
});
test('export never selects page content or private URLs and has an explicit row cap', () => {
  const sql = cohortExportQuery({ start: options.start, end: options.end });
  expect(sql).not.toMatch(/site_url|post_content|page_url|email|license_key/);
  expect(sql).toContain('LIMIT 10000');
  expect(() => cohortExportQuery({ ...options, limit: -1 })).toThrow();
});
test('unresolved server transport cannot turn a filtered dataset into zero', () => {
  const r = calculate([event('title_meta_generated', '2026-10-02T00:00:00Z', { traffic_type: 'Automation' })], options);
  expect(r.successes.status).toBe('U');
});
test('rolling dashboard query does not freeze a historical cutoff', () => {
  const { rollingDeliveryQuery } = require('../../lib/operatingReport/queries');
  expect(rollingDeliveryQuery()).toContain('now() - INTERVAL 7 DAY');
  expect(rollingDeliveryQuery()).not.toContain('2026-10');
});
test('explicit v2 plugin context distinguishes automatic transport from QA', () => {
  const p = { ...props, traffic_type: 'Automation', telemetry_schema: 'opptiai_usage_v2', telemetry_source: 'wordpress', is_test: false };
  expect(exclusion(p)).toBeNull();
  expect(exclusion({ ...p, is_test: true })).toBe('QA');
  expect(exclusion({ ...p, telemetry_consent: false })).not.toBeNull();
});

describe('export fidelity and legacy rows', () => {
  const alt = { plugin_slug: 'beepbeep-ai-alt-text-generator', product: 'alt_text', telemetry_schema: 'opptiai_usage_v2', telemetry_source: 'wordpress', environment: 'production', site_install_id: 'install-alt-1' };
  const altOptions = { ...options, product: 'alt_text' };
  const row = (id, extra = {}) => ({ uuid: `u-${id}`, event: 'alt_generated', timestamp: '2026-10-10T00:00:00Z', properties: { ...alt, operation_id: `op-${id}`, telemetry_consent: true, is_test: false, traffic_type: 'Automation', ...extra } });

  test('string booleans from a HogQL export still count', () => {
    const r = calculate([row(1, { telemetry_consent: 'true', is_test: 'false' }), row(2, { telemetry_consent: 'true', is_test: 'false' })], altOptions);
    expect(r.successes).toEqual({ value: 2, status: 'measured' });
  });

  test("string 'true' is_test is still excluded as QA", () => {
    expect(exclusion(row(3, { is_test: 'true' }).properties, 'alt_generated')).toBe('QA');
  });

  test("string 'false' consent is not consent", () => {
    expect(exclusion(row(4, { telemetry_consent: 'false', traffic_type: undefined, traffic_origin: 'customer_action' }).properties, 'alt_generated')).toBe('consent coverage unknown');
  });

  test('a success row with no environment is unknown and makes the total U, not silently dropped', () => {
    const legacy = { uuid: 'L1', event: 'alt_generated', timestamp: '2026-10-10T00:00:00Z', properties: { plugin_slug: 'beepbeep-ai-alt-text-generator', operation_id: 'legacy1', site_install_id: 'install-legacy' } };
    expect(exclusion(legacy.properties, 'alt_generated')).toBe('environment unknown');
    const r = calculate([row(5), legacy], altOptions);
    expect(r.successes.status).toBe('U');
  });

  test('a non-success diagnostic row with no environment is excluded without blocking the total', () => {
    const diagnostic = { uuid: 'D1', event: 'generation_completed', timestamp: '2026-10-10T00:00:00Z', properties: { plugin_slug: 'beepbeep-ai-alt-text-generator', operation_id: 'gen1', site_install_id: 'install-alt-1' } };
    expect(exclusion(diagnostic.properties, 'generation_completed')).toBe('environment');
    expect(calculate([row(6), diagnostic], altOptions).successes).toEqual({ value: 1, status: 'measured' });
  });

  test('staging rows stay excluded as environment', () => {
    expect(exclusion(row(7, { environment: 'staging' }).properties, 'alt_generated')).toBe('environment');
  });

  test.each([['beepbeep-titles', 'title_meta'], ['oppti-internal-linking', 'internal_linking']])('legacy slug %s maps to %s', (slug, product) => {
    expect(productOf({ plugin_slug: slug })).toBe(product);
  });

  test('legacy slug that conflicts with an explicit product is still Unclassified', () => {
    expect(productOf({ plugin_slug: 'beepbeep-titles', product: 'alt_text' })).toBe('Unclassified');
  });
});
