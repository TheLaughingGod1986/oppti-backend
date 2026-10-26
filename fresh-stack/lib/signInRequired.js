// One reply for billing calls that need a signed-in account or a licence key:
// a fixed code and message, the same bytes on every route. Each reply counts
// against a per-IP limit; past it the caller gets one fixed 429 instead.
const { getClientIp, recordHit } = require('./checkoutRateLimit');

const SIGN_IN_REQUIRED_BODY = Object.freeze({
  code: 'SIGN_IN_REQUIRED',
  message: 'Sign in to manage billing.'
});

const SIGN_IN_RATE_LIMITED_BODY = Object.freeze({
  code: 'RATE_LIMIT_EXCEEDED',
  message: 'Too many requests. Please wait a few minutes and try again.'
});

function getSignInRefusalLimit() {
  const configured = Number(process.env.SIGN_IN_REFUSAL_RATE_LIMIT_PER_15_MIN);
  return Number.isFinite(configured) && configured > 0 ? configured : 60;
}

function sendSignInRequired(req, res) {
  const limit = recordHit(['sign-in-required', getClientIp(req)].join(':'), getSignInRefusalLimit());
  if (!limit.allowed) {
    res.set('Retry-After', String(limit.retryAfterSeconds));
    return res.status(429).json(SIGN_IN_RATE_LIMITED_BODY);
  }
  return res.status(401).json(SIGN_IN_REQUIRED_BODY);
}

module.exports = { SIGN_IN_REQUIRED_BODY, SIGN_IN_RATE_LIMITED_BODY, sendSignInRequired, getSignInRefusalLimit };
