/**
 * Email redaction for log output.
 *
 * Stripe error messages can echo the customer email we sent (e.g. "Invalid
 * email address: jane@example.com"), so anything logged from billing paths is
 * passed through redactEmails() first. Emails become "j***@example.com".
 */

const EMAIL_RE = /([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;
const MAX_DEPTH = 6;

function redactEmailsInString(value) {
  if (typeof value !== 'string' || value.indexOf('@') === -1) return value;
  return value.replace(EMAIL_RE, (_m, first, domain) => `${first}***@${domain}`);
}

function redactEmails(value, depth = 0, seen = new WeakSet()) {
  if (typeof value === 'string') return redactEmailsInString(value);
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);

  if (value instanceof Error) {
    // Keep the useful Stripe/HTTP fields; drop raw/headers payloads that can
    // carry request bodies.
    const out = {
      name: value.name,
      message: redactEmailsInString(value.message)
    };
    for (const key of ['code', 'type', 'statusCode', 'status', 'param', 'decline_code', 'requestId', 'doc_url']) {
      if (value[key] !== undefined) out[key] = redactEmails(value[key], depth + 1, seen);
    }
    if (value.raw && typeof value.raw === 'object' && typeof value.raw.message === 'string') {
      out.raw_message = redactEmailsInString(value.raw.message);
    }
    if (typeof value.stack === 'string') out.stack = redactEmailsInString(value.stack);
    return out;
  }

  if (Array.isArray(value)) return value.map((entry) => redactEmails(entry, depth + 1, seen));

  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    // Leave class instances (Dates, Buffers, ...) alone unless they stringify to an email.
    return value;
  }

  const out = {};
  for (const [key, entry] of Object.entries(value)) {
    out[key] = redactEmails(entry, depth + 1, seen);
  }
  return out;
}

// Stripe customer / subscription / checkout-session ids: keep the prefix and
// the last 4 characters so log lines can still be correlated.
const STRIPE_ID_RE = /\b(cus|sub|cs)_((?:live|test)_)?([A-Za-z0-9]+)/g;

function redactStripeIdsInString(value) {
  if (typeof value !== 'string' || value.indexOf('_') === -1) return value;
  return value.replace(STRIPE_ID_RE, (_m, prefix, mode = '', rest) => `${prefix}_${mode || ''}***${rest.length > 8 ? rest.slice(-4) : ''}`);
}

function mapStrings(value, fn, depth = 0, seen = new WeakSet()) {
  if (typeof value === 'string') return fn(value);
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((entry) => mapStrings(entry, fn, depth + 1, seen));
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return value;
  const out = {};
  for (const [key, entry] of Object.entries(value)) {
    out[key] = mapStrings(entry, fn, depth + 1, seen);
  }
  return out;
}

function redactStripeIds(value) {
  return mapStrings(value, redactStripeIdsInString);
}

module.exports = { redactEmails, redactEmailsInString, redactStripeIds, redactStripeIdsInString };
