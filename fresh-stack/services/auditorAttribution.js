const logger = require('../lib/logger');

// Website Auditor check ids accepted for sign-up attribution (new ids only).
const AUDITOR_FINDING_IDS = Object.freeze([
  'missing_alt',
  'search_engines_discouraged',
  'https_not_enforced',
  'sitemap_missing',
  'canonical_missing',
  'og_tags_missing'
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
    const result = await supabase.from('licenses').update(patch).eq('id', userId);
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
