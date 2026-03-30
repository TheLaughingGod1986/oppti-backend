/**
 * Simple per-license rate limiter.
 * Uses Redis if available, otherwise in-memory fallback.
 */

const PLAN_LIMITS = {
  free: 60,
  pro: 120,
  agency: 240
};

function getClientIp(req) {
  return req.ip
    || req.headers['x-forwarded-for']?.split(',')[0]?.trim()
    || req.connection?.remoteAddress
    || 'unknown-ip';
}

function getSiteKey(req) {
  return req.header('X-Site-Key') || req.header('X-Site-Hash') || 'anon-site';
}

function getUserKey(req) {
  return req.user?.id
    || req.license?.id
    || req.license?.license_key
    || req.header('X-License-Key')
    || req.header('Authorization')
    || 'anon-user';
}

async function incrementBucket({ redis, memoryBuckets, bucketKey, windowMs }) {
  if (redis) {
    const count = await redis.incr(bucketKey);
    await redis.expire(bucketKey, Math.ceil(windowMs / 1000));
    return count;
  }

  const now = Date.now();
  const windowStart = now - windowMs;
  const hits = memoryBuckets.get(bucketKey) || [];
  const recent = hits.filter((ts) => ts >= windowStart);
  recent.push(now);
  memoryBuckets.set(bucketKey, recent);
  return recent.length;
}

function rateLimitResponse(res, limit) {
  return res.status(429).json({
    error: 'RATE_LIMIT_EXCEEDED',
    message: `Rate limit of ${limit} requests/minute exceeded`,
    code: 'RATE_LIMIT_EXCEEDED',
    retry_after: 60
  });
}

function rateLimitMiddleware({ redis, perSiteOverride, globalOverride }) {
  const windowMs = 60_000;
  const memoryBuckets = new Map();

  return async function rateLimit(req, res, next) {
    const plan = req.license?.plan || 'free';
    const limit = perSiteOverride || PLAN_LIMITS[plan] || PLAN_LIMITS.free;
    const globalLimit = globalOverride || 0;
    const minuteBucket = Math.floor(Date.now() / windowMs);
    const ip = getClientIp(req);
    const siteKey = getSiteKey(req);
    const userKey = getUserKey(req);
    const authLimit = Number(process.env.AUTH_RATE_LIMIT_PER_IP || 20);
    const siteIpLimit = Number(process.env.RATE_LIMIT_PER_SITE_IP || limit);
    const userLimit = Number(process.env.RATE_LIMIT_PER_USER || limit);

    try {
      if (req.path.startsWith('/auth')) {
        const authCount = await incrementBucket({
          redis,
          memoryBuckets,
          bucketKey: `ratelimit:auth:${ip}:${minuteBucket}`,
          windowMs
        });
        if (authCount > authLimit) {
          return rateLimitResponse(res, authLimit);
        }
      }

      if (req.path.startsWith('/api/alt-text')) {
        const siteIpCount = await incrementBucket({
          redis,
          memoryBuckets,
          bucketKey: `ratelimit:site-ip:${siteKey}:${ip}:${minuteBucket}`,
          windowMs
        });
        if (siteIpCount > siteIpLimit) {
          return rateLimitResponse(res, siteIpLimit);
        }

        const userCount = await incrementBucket({
          redis,
          memoryBuckets,
          bucketKey: `ratelimit:user:${userKey}:${minuteBucket}`,
          windowMs
        });
        if (userCount > userLimit) {
          return rateLimitResponse(res, userLimit);
        }
      } else {
        const key = req.license?.license_key || req.header('X-License-Key') || ip;
        const count = await incrementBucket({
          redis,
          memoryBuckets,
          bucketKey: `ratelimit:${key}:${minuteBucket}`,
          windowMs
        });
        if (count > limit) {
          return rateLimitResponse(res, limit);
        }
      }

      if (globalLimit > 0) {
        const globalCount = await incrementBucket({
          redis,
          memoryBuckets,
          bucketKey: `ratelimit:global:${minuteBucket}`,
          windowMs
        });
        if (globalCount > globalLimit) {
          return rateLimitResponse(res, globalLimit);
        }
      }

      return next();
    } catch (_error) {
      // Fail-open to avoid blocking traffic on Redis or limiter errors.
      return next();
    }
  };
}

module.exports = rateLimitMiddleware;
