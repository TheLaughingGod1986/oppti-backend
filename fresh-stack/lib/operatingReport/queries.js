const { windows } = require('./index');
function quote(value) { return "'" + String(value).replace(/'/g, "''") + "'"; }
function timestamp(value) { return `toDateTime(${quote(new Date(value).toISOString().slice(0, 19).replace('T', ' '))})`; }
/** Record inspection/quality audit: observed rows are NOT customer-use totals. */
function deliveryQuery(end) {
  const periods = windows(end);
  const time = timestamp(end);
  const from = timestamp(periods.context7d.start);
  const product = `multiIf(
    properties.plugin_slug = 'beepbeep-ai-alt-text-generator' AND (empty(coalesce(toString(properties.product), '')) OR properties.product IN ('alt_text','alt-text')), 'alt_text',
    properties.plugin_slug = 'opptiai-titles' AND (empty(coalesce(toString(properties.product), '')) OR properties.product IN ('title_meta','titles','meta_titles_descriptions')), 'title_meta',
    properties.plugin_slug = 'opptiai-internal-linking' AND (empty(coalesce(toString(properties.product), '')) OR properties.product = 'internal_linking'), 'internal_linking',
    empty(coalesce(toString(properties.plugin_slug), '')) AND properties.product IN ('alt_text','alt-text'), 'alt_text',
    empty(coalesce(toString(properties.plugin_slug), '')) AND properties.product IN ('title_meta','titles','meta_titles_descriptions'), 'title_meta',
    empty(coalesce(toString(properties.plugin_slug), '')) AND properties.product = 'internal_linking', 'internal_linking',
    empty(coalesce(toString(properties.plugin_slug), '')) AND (properties.source_surface = 'website' OR (properties.$lib = 'web' AND properties.$host IN ('oppti.dev','www.oppti.dev'))), 'website',
    'Unclassified')`;
  const base = `SELECT event, timestamp, uuid, properties, $virt_traffic_type AS traffic, ${product} AS product FROM events WHERE timestamp >= ${from} AND timestamp < ${time} AND event NOT IN ('wporg_downloads_daily','wporg_stats_snapshot') AND event NOT LIKE '$%'`;
  return Object.entries(periods).map(([period, bounds]) => `SELECT ${quote(period)} AS period, product, event,
    count() AS observed_rows, uniqExact(uuid) AS unique_ingested_rows,
    countIf(notEmpty(toString(properties.site_install_id))) AS with_install_id,
    countIf(notEmpty(toString(properties.account_id))) AS with_account_id,
    countIf(notEmpty(toString(properties.journey_id))) AS with_journey_id,
    countIf(notEmpty(toString(properties.generation_run_id)) OR notEmpty(toString(properties.operation_id))) AS with_operation_id,
    countIf(properties.environment = 'production') AS tagged_production,
    countIf(traffic = 'Regular') AS regular_transport,
    countIf(traffic = 'Automation') AS automated_transport,
    max(timestamp) AS last_seen
    FROM (${base}) WHERE timestamp >= ${timestamp(bounds.start)} AND timestamp < ${timestamp(bounds.end)}
    GROUP BY product, event`).join('\nUNION ALL\n') + '\nORDER BY period, product, event';
}
/** Privacy-safe export for calculate(): stable install pseudonyms, never host/content. */
function cohortExportQuery({ start, end, limit = 10000 }) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100000) throw new Error('Invalid export limit');
  windows(end);
  if (!(Date.parse(start) < Date.parse(end))) throw new Error('Invalid reporting bounds');
  return `SELECT uuid, event, timestamp,
    properties.plugin_slug AS plugin_slug, properties.product AS product,
    properties.site_install_id AS site_install_id, properties.operation_id AS operation_id,
    properties.generation_run_id AS generation_run_id, properties.$insert_id AS insert_id,
    properties.environment AS environment, properties.is_test AS is_test,
    properties.is_internal AS is_internal, properties.telemetry_consent AS telemetry_consent,
    properties.traffic_origin AS traffic_origin, properties.telemetry_schema AS telemetry_schema,
    properties.telemetry_source AS telemetry_source, $virt_traffic_type AS traffic_type,
    properties.success AS success
    FROM events WHERE timestamp >= ${timestamp(start)} AND timestamp < ${timestamp(end)}
    AND event IN ('plugin_activated','alt_generated','title_meta_generated','link_inserted')
    ORDER BY timestamp, uuid LIMIT ${limit}`;
}
function rollingDeliveryQuery() {
  const anchor = '2026-10-27T08:55:00Z';
  let sql = deliveryQuery(anchor);
  for (const days of [0, 1, 2, 7]) {
    const literal = timestamp(Date.parse(anchor) - days * 86400000);
    sql = sql.split(literal).join(days ? `(now() - INTERVAL ${days} DAY)` : 'now()');
  }
  return sql;
}
module.exports = { deliveryQuery, cohortExportQuery, rollingDeliveryQuery };
