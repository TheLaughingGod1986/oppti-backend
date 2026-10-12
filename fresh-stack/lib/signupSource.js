const SIGNUP_SOURCE_VALUES = Object.freeze([
  'wporg_search',
  'google',
  'ai_assistant',
  'oppti_site',
  'friend_colleague',
  'social',
  'other'
]);

const SIGNUP_SOURCE_OTHER_MAX = 200;

function sanitizeOtherText(value) {
  if (typeof value !== 'string') return null;
  const stripped = value
    .replace(/<[^>]*>/g, ' ')
    .replace(/[<>]/g, '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, SIGNUP_SOURCE_OTHER_MAX)
    .trim();
  return stripped || null;
}

/**
 * Normalise the optional "How did you find us?" answer.
 * Never throws: unknown values are dropped (and reported via `invalid`)
 * so sign-up can never fail because of this field.
 */
function normalizeSignupSource(body = {}) {
  const rawSource = body?.signup_source;
  const rawOther = body?.signup_source_other;
  let source = null;
  let invalid = null;

  if (typeof rawSource === 'string' && rawSource.trim() !== '') {
    const candidate = rawSource.trim().toLowerCase();
    if (SIGNUP_SOURCE_VALUES.includes(candidate)) {
      source = candidate;
    } else {
      invalid = rawSource.slice(0, 64);
    }
  } else if (rawSource !== undefined && rawSource !== null && rawSource !== '') {
    invalid = String(typeof rawSource);
  }

  // Free text is only kept alongside "other".
  const other = source === 'other' ? sanitizeOtherText(rawOther) : null;

  return { source, other, invalid };
}

module.exports = {
  SIGNUP_SOURCE_VALUES,
  SIGNUP_SOURCE_OTHER_MAX,
  normalizeSignupSource,
  sanitizeOtherText
};
