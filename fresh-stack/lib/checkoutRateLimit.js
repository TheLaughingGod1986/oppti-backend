const logger = require('./logger');

// In-memory request counters shared by billing routes: 15-minute window,
// keyed by caller-chosen bucket names.
const CHECKOUT_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const checkoutRateBuckets = new Map();

function pruneCheckoutRateBuckets(now = Date.now()) {
  for (const [key, hits] of checkoutRateBuckets.entries()) {
    const recent = hits.filter((timestamp) => now - timestamp < CHECKOUT_RATE_LIMIT_WINDOW_MS);
    if (recent.length) {
      checkoutRateBuckets.set(key, recent);
    } else {
      checkoutRateBuckets.delete(key);
    }
  }
}

function getClientIp(req) {
  return req.ip
    || req.headers['x-forwarded-for']?.split(',')[0]?.trim()
    || req.connection?.remoteAddress
    || 'unknown-ip';
}

// Route template (no ids or query string) for the block log line.
function routeLabel(req) {
  if (!req) return null;
  const template = req.route?.path;
  return `${req.method || ''} ${(req.baseUrl || '') + (typeof template === 'string' ? template : (req.path || ''))}`.trim() || null;
}

// Records one hit in a bucket and reports whether it is within the limit.
// options: { limiter, req, now } (a number is still accepted as now). When a
// hit is over the limit, one structured line is logged with the limiter name
// and route only: never the bucket key, IP, email, account or licence key.
function recordHit(bucketKey, limit, options = {}) {
  const opts = typeof options === 'number' ? { now: options } : (options || {});
  const now = opts.now ?? Date.now();
  pruneCheckoutRateBuckets(now);
  const hits = checkoutRateBuckets.get(bucketKey) || [];
  hits.push(now);
  checkoutRateBuckets.set(bucketKey, hits);
  const result = {
    allowed: hits.length <= limit,
    count: hits.length,
    limit,
    retryAfterSeconds: Math.ceil(CHECKOUT_RATE_LIMIT_WINDOW_MS / 1000)
  };
  if (!result.allowed) {
    logger.warn('[rate-limit] blocked', {
      limiter: opts.limiter || 'unnamed',
      route: routeLabel(opts.req),
      limit,
      count: result.count,
      window_seconds: result.retryAfterSeconds
    });
  }
  return result;
}

module.exports = {
  CHECKOUT_RATE_LIMIT_WINDOW_MS,
  checkoutRateBuckets,
  pruneCheckoutRateBuckets,
  getClientIp,
  recordHit
};
