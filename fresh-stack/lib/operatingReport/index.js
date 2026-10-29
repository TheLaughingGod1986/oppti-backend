const DAY = 86400000;
const PRODUCTS = { 'beepbeep-ai-alt-text-generator': 'alt_text', 'opptiai-titles': 'title_meta', 'opptiai-internal-linking': 'internal_linking' };
// Older builds sent the repository / text-domain slug instead of the WP.org slug.
const LEGACY_SLUGS = { 'beepbeep-titles': 'title_meta', 'oppti-internal-linking': 'internal_linking' };
const ALIASES = { alt_text: 'alt_text', 'alt-text': 'alt_text', title_meta: 'title_meta', meta_titles_descriptions: 'title_meta', titles: 'title_meta', internal_linking: 'internal_linking', website: 'website' };
const SUCCESS = { alt_text: 'alt_generated', title_meta: 'title_meta_generated', internal_linking: 'link_inserted' };
const unavailable = reason => ({ value: null, status: 'U', reason });
const measured = value => ({ value, status: 'measured' });
// HogQL exports can return JSON booleans as the strings 'true'/'false'.
function bool(v) {
  if (v === true || v === 'true') return true;
  if (v === false || v === 'false') return false;
  return undefined;
}
const SUCCESS_EVENTS = new Set(Object.values(SUCCESS));
function productOf(p) {
  const slug = PRODUCTS[p.plugin_slug] || LEGACY_SLUGS[p.plugin_slug];
  const explicit = ALIASES[p.product];
  if (slug && p.product && explicit !== slug) return 'Unclassified';
  return slug || explicit || (p.source_surface === 'website' ? 'website' : 'Unclassified');
}
function exclusion(p, event) {
  // A missing environment is unknown, never assumed production and never silently dropped.
  const environment = p.environment === undefined || p.environment === null || p.environment === '' ? 'unknown' : p.environment;
  if (environment !== 'production' && environment !== 'unknown') return 'environment';
  if ([p.is_test, p.is_internal, p.is_qa].some(v => bool(v) === true)) return 'QA';
  const host = String(p.site_host || p.host || p.domain || p.site_url || '').toLowerCase();
  if (/(localhost|127\.0\.0\.1|\[?::1\]?|wpsandbox|tastewp|playground\.wordpress|wp-env|\.local\b|\.test\b|myftpupload|hostingersite|pmwdev|edge-|render\.com|smoke-test|smoke-account|rollout_smoke|example\.com|trycloudflare|instawp)/.test(host)) return 'QA host';
  if (environment === 'unknown') return SUCCESS_EVENTS.has(event) ? 'environment unknown' : 'environment';
  const consent = bool(p.telemetry_consent);
  const trustedPluginTransport = p.telemetry_schema === 'opptiai_usage_v2' && ['wordpress', 'backend'].includes(p.telemetry_source) && consent === true && bool(p.is_test) === false && !!p.site_install_id;
  if (p.traffic_type && p.traffic_type !== 'Regular' && !(p.traffic_type === 'Automation' && trustedPluginTransport)) return 'unresolved automated transport';
  if (consent !== true && p.source_surface !== 'website') return 'consent coverage unknown';
  if (!p.traffic_type && p.traffic_origin !== 'customer_action' && !trustedPluginTransport) return 'traffic origin unknown';
  return null;
}
function deduplicate(rows) {
  const seen = new Set();
  return rows.filter(row => {
    const p = row.properties || {};
    // Operation IDs are per successful action; attachment ID alone loses repeats.
    const operation = p.operation_id || p.generation_run_id || p.$insert_id || row.uuid;
    if (!operation) return true; // keep diagnostic rows; metric coverage gate handles missing IDs
    const key = [productOf(p), p.site_install_id || '', row.event, operation].join(':');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
function median(values) {
  const a = [...values].sort((x, y) => x - y), n = a.length;
  return n ? (a[Math.floor((n - 1) / 2)] + a[Math.floor(n / 2)]) / 2 : null;
}
function windows(end) {
  const upper = Date.parse(end);
  if (!Number.isFinite(upper)) throw new Error('Explicit valid UTC end is required');
  return Object.fromEntries([['latest24h', 1, 0], ['preceding24h', 2, 1], ['context7d', 7, 0]].map(([key, from, to]) => [key, { start: new Date(upper - from * DAY).toISOString(), end: new Date(upper - to * DAY).toISOString() }]));
}
/** Coverage is release/ingestion evidence, never inferred from schema or an empty result. */
function calculate(rows, { start, end, product, coverage = {} }) {
  const lower = Date.parse(start), upper = Date.parse(end);
  if (!(upper > lower)) throw new Error('Invalid reporting bounds');
  const all = deduplicate(rows).filter(r => Number.isFinite(Date.parse(r.timestamp)) && Date.parse(r.timestamp) < upper);
  const relevant = all.filter(r => productOf(r.properties || {}) === product && !exclusion(r.properties || {}, r.event));
  const current = relevant.filter(r => Date.parse(r.timestamp) >= lower);
  const successful = r => r.event === SUCCESS[product] && bool((r.properties || {}).success) !== false;
  const result = {
    observed_success_events: current.filter(successful).length,
    successes: unavailable('Production delivery and complete instrumentation not verified'),
    activation_conversion: unavailable('Activation/success identity linkage or denominator unavailable'),
    median_time_to_first_value_seconds: unavailable('Complete activation history unavailable'),
    repeat_success_identities: unavailable('Success history or operation deduplication unavailable'),
    seven_day_retention: unavailable('Eligible cohort or complete eight-day follow-up unavailable'),
    lifecycle: unavailable('Complete identity history unavailable'),
    excluded_rows: all.filter(r => productOf(r.properties || {}) === product && exclusion(r.properties || {}, r.event)).length
  };
  if (all.some(r => productOf(r.properties || {}) === product && /unknown|unresolved/.test(exclusion(r.properties || {}, r.event) || ''))) {
    result.successes = unavailable('Customer traffic or consent attribution unresolved');
    return result;
  }
  if (!coverage.productionVerified || !coverage.successComplete) return result;
  const successRows = relevant.filter(successful);
  if (successRows.some(r => !r.properties.site_install_id || !(r.properties.operation_id || r.properties.generation_run_id || r.properties.$insert_id))) {
    result.successes = unavailable('Missing installation or operation ID');
    return result;
  }
  result.successes = measured(current.filter(successful).length);
  if (!coverage.historyComplete) return result;
  const groups = new Map();
  for (const r of relevant) {
    const id = r.properties.site_install_id;
    if (!id) continue;
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(r);
  }
  for (const events of groups.values()) events.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  const successes = [...groups.values()].map(events => events.filter(successful)).filter(events => events.length);
  result.repeat_success_identities = measured(successes.filter(events => events.length >= 2 && events.slice(1).some(r => Date.parse(r.timestamp) >= lower)).length);
  if (coverage.activationComplete && !relevant.some(r => r.event === 'plugin_activated' && !r.properties.site_install_id)) {
    // Fixed seven-day conversion horizon; only fully observed activation cohorts qualify.
    const entrants = [...groups.values()].map(events => {
      const activation = events.find(r => r.event === 'plugin_activated');
      if (!activation) return null;
      const at = Date.parse(activation.timestamp);
      if (at < lower || at >= upper - 7 * DAY) return null;
      const first = events.find(r => successful(r) && Date.parse(r.timestamp) >= at && Date.parse(r.timestamp) < at + 7 * DAY);
      return { at, first };
    }).filter(Boolean);
    if (entrants.length) {
      const converted = entrants.filter(e => e.first);
      result.activation_conversion = { ...measured(converted.length / entrants.length), numerator: converted.length, denominator: entrants.length, horizon_days: 7 };
      result.median_time_to_first_value_seconds = converted.length ? measured(median(converted.map(e => (Date.parse(e.first.timestamp) - e.at) / 1000))) : unavailable('No converted eligible installations');
    }
  }
  // Day-7 retention = successful return in [first success + 7d, +8d).
  const eligible = successes.filter(events => Date.parse(events[0].timestamp) >= lower && Date.parse(events[0].timestamp) + 8 * DAY <= upper);
  if (eligible.length) {
    const retained = eligible.filter(events => events.slice(1).some(r => { const d = Date.parse(r.timestamp) - Date.parse(events[0].timestamp); return d >= 7 * DAY && d < 8 * DAY; })).length;
    result.seven_day_retention = { ...measured(retained / eligible.length), numerator: retained, denominator: eligible.length };
  }
  const lifecycle = { New: 0, Returning: 0, Resurrected: 0 };
  for (const events of successes) {
    if (!events.some(r => Date.parse(r.timestamp) >= lower)) continue;
    const prior = events.filter(r => Date.parse(r.timestamp) < lower);
    if (!prior.length) lifecycle.New++;
    else if (Date.parse(prior.at(-1).timestamp) >= lower - (upper - lower)) lifecycle.Returning++;
    else lifecycle.Resurrected++;
  }
  result.lifecycle = measured(lifecycle);
  return result;
}
module.exports = { productOf, exclusion, deduplicate, calculate, windows, bool, PRODUCTS, LEGACY_SLUGS, SUCCESS };
