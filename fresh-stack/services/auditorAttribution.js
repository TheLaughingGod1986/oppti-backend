const logger = require('../lib/logger');

// Website Auditor check ids accepted for sign-up attribution (new ids only).
// Mirrors check_categories() in the Auditor's includes/check-copy.php plus
// title_too_long. Must equal fresh-stack/tests/fixtures/auditor-check-ids.json
// (a test enforces this). The DB only checks the format.
const AUDITOR_FINDING_IDS = Object.freeze([
  'missing_alt',
  'needs_review',
  'missing_title',
  'duplicate_title',
  'missing_meta',
  'noindex_pages',
  'canonical_missing',
  'og_tags_missing',
  'orphan_pages',
  'thin_links',
  'search_engines_discouraged',
  'https_not_enforced',
  'robots_txt',
  'sitemap_missing',
  'llms_txt',
  'schema',
  'performance',
  'accessibility',
  'title_too_long'
]);

// Pre-rename check names, mapped the same way Alt Text #61 maps them.
const LEGACY_AUDITOR_FINDING_MAP = Object.freeze({
  search_indexing: 'search_engines_discouraged',
  https: 'https_not_enforced',
  sitemap: 'sitemap_missing',
  canonical: 'canonical_missing',
  open_graph: 'og_tags_missing'
});

const MAX_RAW_LENGTH = 64;

// Values the licenses_signup_plugin_check allowed before website_auditor.
const LEGACY_SIGNUP_PLUGIN_IDS = Object.freeze(['alt_text', 'titles', 'internal_linking', 'content_refresh']);

function normalizeOne(value) {
  if (typeof value !== 'string') return null;
  if (value.length === 0 || value.length > MAX_RAW_LENGTH) return null;
  const key = value.trim().toLowerCase();
  if (AUDITOR_FINDING_IDS.includes(key)) return key;
  if (Object.prototype.hasOwnProperty.call(LEGACY_AUDITOR_FINDING_MAP, key)) {
    return LEGACY_AUDITOR_FINDING_MAP[key];
  }
  return null;
}

// Prefer `finding`, fall back to `auditor_source`. Anything unknown,
// non-string or longer than 64 raw characters becomes null.
function normalizeAuditorFinding({ finding, auditor_source: auditorSource } = {}) {
  return normalizeOne(finding) || normalizeOne(auditorSource);
}

function buildSignupAttribution(body = {}) {
  const auditorFinding = normalizeAuditorFinding(body || {});
  return {
    auditor_finding: auditorFinding,
    signup_source_auditor: auditorFinding !== null
  };
}

// Best-effort write onto the new licenses row. Never throws: a missing
// column (migration not applied) or any DB error is logged and ignored so
// registration still succeeds.
async function recordSignupAttribution({ supabase, userId, pluginId, body, requestId = null }) {
  const attribution = buildSignupAttribution(body);
  const patch = {
    signup_plugin: typeof pluginId === 'string' ? pluginId : null,
    ...attribution
  };
  try {
    let result = await supabase.from('licenses').update(patch).eq('id', userId);
    // A database without the widened licenses_signup_plugin_check (migration
    // 030 not applied) rejects website_auditor. Keep the Auditor fields.
    if (result && result.error && patch.signup_plugin && !LEGACY_SIGNUP_PLUGIN_IDS.includes(patch.signup_plugin)) {
      logger.warn('[auth] signup_plugin_value_rejected_retrying_without', {
        user_id: userId,
        request_id: requestId,
        signup_plugin: patch.signup_plugin
      });
      const { signup_plugin: _dropped, ...rest } = patch;
      result = await supabase.from('licenses').update(rest).eq('id', userId);
    }
    const error = result && result.error;
    if (error) {
      logger.warn('[auth] signup_attribution_failed', {
        user_id: userId,
        request_id: requestId,
        error: error.message || String(error)
      });
      return { ...patch, error };
    }
    return { ...patch, error: null };
  } catch (error) {
    logger.warn('[auth] signup_attribution_failed', {
      user_id: userId,
      request_id: requestId,
      error: (error && error.message) || String(error)
    });
    return { ...patch, error };
  }
}

module.exports = {
  AUDITOR_FINDING_IDS,
  LEGACY_AUDITOR_FINDING_MAP,
  MAX_RAW_LENGTH,
  normalizeAuditorFinding,
  buildSignupAttribution,
  recordSignupAttribution
};
