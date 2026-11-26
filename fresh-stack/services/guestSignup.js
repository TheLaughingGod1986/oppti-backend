/**
 * Guest-to-account conversion markers on a new account (licenses row).
 *
 *  - signup_entry: where in the plugin the account was created. Only
 *    'guest_trial' is accepted today: the plugin sends it from the guest
 *    flow's Create account click (Titles 1.0.33+). Kept apart from
 *    signup_source, which is the user's own "How did you find us?" answer.
 *  - converted_from_guest: true when the registering site already had
 *    guest-trial rows (usage_logs is_trial / generation_requests 'trial')
 *    before the account existed. Decided from the data, not from the plugin.
 *
 * Both are written in a separate best-effort update, after signup_plugin is
 * stored, so a database without these columns (migration not applied yet)
 * never loses signup_plugin or fails sign-up.
 */

const logger = require('../lib/logger');
const { serializeSupabaseError } = require('../lib/supabaseErrors');

const SIGNUP_ENTRY_VALUES = Object.freeze(['guest_trial']);

function normalizeSignupEntry(body = {}) {
  const raw = body?.signup_entry;
  if (typeof raw !== 'string') return null;
  const value = raw.trim().toLowerCase();
  if (!value || value.length > 64) return null;
  return SIGNUP_ENTRY_VALUES.includes(value) ? value : null;
}

function hasGuestRows(linkResult) {
  if (!linkResult || linkResult.skipped) return false;
  return Number(linkResult.usage_logs || 0) > 0 || Number(linkResult.generation_requests || 0) > 0;
}

async function recordGuestSignupMarkers({ supabase, user, signupEntry = null, linkResult = null, requestId = null }) {
  const patch = {};
  if (signupEntry) patch.signup_entry = signupEntry;
  if (hasGuestRows(linkResult)) patch.converted_from_guest = true;
  if (!user?.id || !supabase || Object.keys(patch).length === 0) {
    return { patch, error: null, written: false };
  }
  try {
    const result = await supabase.from('licenses').update(patch).eq('id', user.id);
    const error = result && result.error;
    if (error) {
      logger.warn('[Auth] guest_signup_markers_write_failed', {
        requestId,
        fields: Object.keys(patch),
        error: serializeSupabaseError(error)
      });
      return { patch, error, written: false };
    }
    Object.assign(user, patch);
    logger.info('[Auth] guest_signup_markers_written', {
      requestId,
      account_id: user.id,
      fields: Object.keys(patch)
    });
    return { patch, error: null, written: true };
  } catch (error) {
    logger.warn('[Auth] guest_signup_markers_write_threw', { requestId, error: error.message });
    return { patch, error, written: false };
  }
}

module.exports = {
  SIGNUP_ENTRY_VALUES,
  hasGuestRows,
  normalizeSignupEntry,
  recordGuestSignupMarkers
};
