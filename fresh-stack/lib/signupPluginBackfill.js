/**
 * Pure rules for the one-off licenses.signup_plugin backfill
 * (scripts/backfill-signup-plugin.js). No I/O here, so the rules are tested
 * without a database.
 *
 * Order (Chief's ruling, 26 Nov 2026), first match wins:
 *   0. Auditor-referred account (signup_source_auditor / auditor_finding)
 *      -> website_auditor, regardless of anything else.
 *   1. first usage row            -> inferred_first_usage
 *   2. Stripe checkout metadata   -> inferred_stripe_checkout
 *   3. first consented PostHog event -> inferred_posthog
 *   4. first plugin connection    -> inferred_first_connection
 *   otherwise null (left blank).
 * Rows that already have signup_plugin are never touched.
 */

const SIGNUP_PLUGIN_IDS = Object.freeze(['alt_text', 'titles', 'internal_linking', 'content_refresh', 'website_auditor']);

const SOURCE = Object.freeze({
  AUDITOR: 'inferred_auditor_referral',
  USAGE: 'inferred_first_usage',
  STRIPE: 'inferred_stripe_checkout',
  POSTHOG: 'inferred_posthog',
  CONNECTION: 'inferred_first_connection'
});

const EXCLUDED_EMAIL_DOMAINS = Object.freeze(['qa.oppti.dev', 'maxxspace.com', 'uberip.com', 'example.invalid']);

// Aliases seen in telemetry / metadata for the same plugin.
const ALIASES = Object.freeze({
  alt_text: 'alt_text',
  'alt-text': 'alt_text',
  alttext: 'alt_text',
  titles: 'titles',
  title_meta: 'titles',
  internal_linking: 'internal_linking',
  'internal-linking': 'internal_linking',
  content_refresh: 'content_refresh',
  'content-refresh': 'content_refresh',
  website_auditor: 'website_auditor',
  'website-auditor': 'website_auditor',
  auditor: 'website_auditor',
  optimizer: 'website_auditor'
});

function normalizePlugin(value) {
  if (typeof value !== 'string') return null;
  const key = value.trim().toLowerCase();
  return ALIASES[key] || null;
}

function isExcludedEmail(email) {
  if (typeof email !== 'string' || !email.includes('@')) return false;
  const domain = email.trim().toLowerCase().split('@').pop();
  return EXCLUDED_EMAIL_DOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`));
}

/**
 * Plugin for a usage_logs row. The endpoint wins over feature_type because
 * unknown feature types default to alt_text in the database.
 */
function pluginFromUsageRow(row = {}) {
  const endpoint = String(row.endpoint || '').toLowerCase().replace(/^\/+/, '');
  if (endpoint.startsWith('api/titles')) return 'titles';
  if (endpoint.startsWith('api/internal-linking')) return 'internal_linking';
  if (endpoint.startsWith('api/content-refresh')) return 'content_refresh';
  if (endpoint.startsWith('api/optimizer')) return 'website_auditor';
  if (endpoint.startsWith('api/alt-text')) return 'alt_text';
  return normalizePlugin(row.feature_type);
}

function earliest(rows = [], timeKey) {
  return rows
    .filter((row) => row && row[timeKey])
    .slice()
    .sort((a, b) => String(a[timeKey]).localeCompare(String(b[timeKey])))[0] || null;
}

function pluginFromStripeMetadata(metadata = {}) {
  return normalizePlugin(metadata.plugin_id)
    || normalizePlugin(metadata.plugin)
    || normalizePlugin(metadata.signup_plugin)
    || normalizePlugin(metadata.trigger_feature)
    || null;
}

/**
 * @param {object} account  { signup_plugin, signup_source_auditor, auditor_finding }
 * @param {object} signals  { usage: [{endpoint, feature_type, created_at}],
 *                            stripe: [{created_at, metadata}],
 *                            posthog: [{timestamp, plugin, consented}],
 *                            connections: [{plugin_id, first_connected_at}] }
 * @returns {{ plugin: string|null, source: string|null, skipped?: string }}
 */
function inferSignupPlugin(account = {}, signals = {}) {
  if (account.signup_plugin) return { plugin: null, source: null, skipped: 'already_set' };

  if (account.signup_source_auditor === true || (typeof account.auditor_finding === 'string' && account.auditor_finding)) {
    return { plugin: 'website_auditor', source: SOURCE.AUDITOR };
  }

  const usage = earliest((signals.usage || []).filter((row) => pluginFromUsageRow(row)), 'created_at');
  if (usage) return { plugin: pluginFromUsageRow(usage), source: SOURCE.USAGE };

  const stripe = earliest((signals.stripe || []).filter((row) => pluginFromStripeMetadata(row.metadata)), 'created_at');
  if (stripe) return { plugin: pluginFromStripeMetadata(stripe.metadata), source: SOURCE.STRIPE };

  const posthog = earliest((signals.posthog || []).filter((row) => row.consented === true && normalizePlugin(row.plugin)), 'timestamp');
  if (posthog) return { plugin: normalizePlugin(posthog.plugin), source: SOURCE.POSTHOG };

  const connection = earliest((signals.connections || []).filter((row) => normalizePlugin(row.plugin_id)), 'first_connected_at');
  if (connection) return { plugin: normalizePlugin(connection.plugin_id), source: SOURCE.CONNECTION };

  return { plugin: null, source: null };
}

/**
 * Counts only: no ids, emails, keys, site hashes or URLs.
 */
function summarize(results = []) {
  const summary = { considered: 0, already_set: 0, excluded: 0, inferred: 0, left_null: 0, by_source: {}, by_plugin: {} };
  for (const r of results) {
    summary.considered += 1;
    if (r.skipped === 'already_set') { summary.already_set += 1; continue; }
    if (r.skipped === 'excluded_email') { summary.excluded += 1; continue; }
    if (!r.plugin) { summary.left_null += 1; continue; }
    summary.inferred += 1;
    summary.by_source[r.source] = (summary.by_source[r.source] || 0) + 1;
    summary.by_plugin[r.plugin] = (summary.by_plugin[r.plugin] || 0) + 1;
  }
  return summary;
}

module.exports = {
  EXCLUDED_EMAIL_DOMAINS,
  SIGNUP_PLUGIN_IDS,
  SOURCE,
  inferSignupPlugin,
  isExcludedEmail,
  normalizePlugin,
  pluginFromStripeMetadata,
  pluginFromUsageRow,
  summarize
};
