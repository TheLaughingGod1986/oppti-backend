// Codes shared by every plugin's "How did you find us?" question.
const SIGNUP_SOURCE_VALUES = Object.freeze([
  'wporg',
  'search',
  'x',
  'facebook_group',
  'friend',
  'other'
]);

// Codes sent by Alt Text 4.6.138/4.6.139 and Titles 1.0.27 pre-release.
// They are accepted and rewritten to the new code before anything is stored.
const OLD_TO_NEW = Object.freeze({
  wporg_search: 'wporg',
  google: 'search',
  ai_assistant: 'other',
  oppti_site: 'other',
  friend_colleague: 'friend',
  social: 'other'
});

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
  let legacy = null;

  if (typeof rawSource === 'string' && rawSource.trim() !== '') {
    const candidate = rawSource.trim().toLowerCase();
    if (SIGNUP_SOURCE_VALUES.includes(candidate)) {
      source = candidate;
    } else if (Object.prototype.hasOwnProperty.call(OLD_TO_NEW, candidate)) {
      source = OLD_TO_NEW[candidate];
      legacy = candidate;
    } else {
      invalid = rawSource.slice(0, 64);
    }
  } else if (rawSource !== undefined && rawSource !== null && rawSource !== '') {
    invalid = String(typeof rawSource);
  }

  // Free text is only kept alongside "other". An old code that maps to
  // "other" keeps the old code as the text so the answer isn't lost.
  let other = source === 'other' ? sanitizeOtherText(rawOther) : null;
  if (source === 'other' && legacy && !other) {
    other = legacy;
  }

  return { source, other, invalid, legacy };
}

module.exports = {
  SIGNUP_SOURCE_VALUES,
  OLD_TO_NEW,
  SIGNUP_SOURCE_OTHER_MAX,
  normalizeSignupSource,
  sanitizeOtherText
};
