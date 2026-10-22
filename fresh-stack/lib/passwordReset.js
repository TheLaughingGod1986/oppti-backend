/**
 * Password reset links (QA security review, 22 Oct 2026).
 *
 * The reset link is built ONLY from a fixed server-side base, never from
 * request input (the old route used the caller's siteUrl as the link host, so
 * anyone could have us email a real reset token pointing at their domain).
 *
 * PASSWORD_RESET_BASE_URL (optional) overrides the default https://oppti.dev.
 * It must be an https URL; anything else is ignored and the default is used.
 * The page is <base>/reset-password?token=..., which is the oppti.dev
 * "Set a new password" page; it posts { token, password } to
 * /auth/reset-password.
 */
const DEFAULT_PASSWORD_RESET_BASE_URL = 'https://oppti.dev';
const PASSWORD_RESET_PATH = '/reset-password';

function getPasswordResetBaseUrl(env = process.env) {
  const raw = typeof env.PASSWORD_RESET_BASE_URL === 'string' ? env.PASSWORD_RESET_BASE_URL.trim() : '';
  if (!raw) return DEFAULT_PASSWORD_RESET_BASE_URL;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password) {
      return DEFAULT_PASSWORD_RESET_BASE_URL;
    }
    return url.origin;
  } catch (_err) {
    return DEFAULT_PASSWORD_RESET_BASE_URL;
  }
}

function buildPasswordResetLink(token, env = process.env) {
  const url = new URL(PASSWORD_RESET_PATH, getPasswordResetBaseUrl(env));
  url.searchParams.set('token', String(token));
  return url.toString();
}

module.exports = {
  DEFAULT_PASSWORD_RESET_BASE_URL,
  PASSWORD_RESET_PATH,
  getPasswordResetBaseUrl,
  buildPasswordResetLink
};
