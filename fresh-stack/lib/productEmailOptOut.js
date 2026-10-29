// "Don't send me product tips and plan emails" checkbox at sign-up.
// Accepts the usual HTML form / JSON truthy encodings. Returns null when the
// field was not sent (older plugins), so we store nothing rather than "false".
const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);
const FALSE_VALUES = new Set(['0', 'false', 'no', 'off', '']);

function normalizeProductEmailsOptOut(body = {}) {
  const raw = body?.product_emails_opt_out;
  if (raw === undefined || raw === null) return null;
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'number') return raw === 1 ? true : (raw === 0 ? false : null);
  if (typeof raw === 'string') {
    const value = raw.trim().toLowerCase();
    if (TRUE_VALUES.has(value)) return true;
    if (FALSE_VALUES.has(value)) return false;
  }
  return null;
}

function isProductEmailsOptedOut(account) {
  return account?.product_emails_opt_out === true;
}

module.exports = { normalizeProductEmailsOptOut, isProductEmailsOptedOut };
