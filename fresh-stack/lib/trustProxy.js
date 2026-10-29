/**
 * Express 'trust proxy' for Render.
 *
 * Without it req.ip is the load balancer's address, so every per-IP limit
 * (the /auth limiter in particular) is one shared bucket. A hop count makes
 * Express take the client address from the right end of X-Forwarded-For,
 * skipping only the hops our own proxies append, so a client cannot pick its
 * address by sending its own X-Forwarded-For. Never use `true` here.
 *
 * TRUST_PROXY_HOPS overrides the default of 1 (0 disables). Set it to the
 * number of proxies Render actually puts in front of the service.
 */
const DEFAULT_TRUST_PROXY_HOPS = 1;
const MAX_TRUST_PROXY_HOPS = 10;

function resolveTrustProxyHops(env = process.env) {
  const raw = env.TRUST_PROXY_HOPS;
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return DEFAULT_TRUST_PROXY_HOPS;
  }
  const value = Number(String(raw).trim());
  if (!Number.isInteger(value) || value < 0 || value > MAX_TRUST_PROXY_HOPS) {
    return DEFAULT_TRUST_PROXY_HOPS;
  }
  return value;
}

/**
 * Logs once per process how many X-Forwarded-For entries a request arrived
 * with (a count only, never an address), so the hop setting can be checked
 * against what Render really sends.
 */
function createProxyHopObserver({ logger, hops }) {
  let logged = false;
  return function observeProxyHops(req, _res, next) {
    if (!logged && logger && typeof logger.info === 'function') {
      logged = true;
      const header = req.headers['x-forwarded-for'];
      const entries = typeof header === 'string' && header.trim()
        ? header.split(',').filter((part) => part.trim()).length
        : 0;
      logger.info('[proxy] first request forwarding chain', {
        x_forwarded_for_entries: entries,
        trust_proxy_hops: hops,
        has_cf_connecting_ip: Boolean(req.headers['cf-connecting-ip'])
      });
    }
    next();
  };
}

module.exports = {
  DEFAULT_TRUST_PROXY_HOPS,
  createProxyHopObserver,
  resolveTrustProxyHops
};
