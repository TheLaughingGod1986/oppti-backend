const { validateLicense } = require('../services/license');
const logger = require('../lib/logger');
const jwt = require('jsonwebtoken');
const { buildAnonymousContext } = require('../lib/anonymousIdentity');
const { sendSignInRequired } = require('../lib/signInRequired');

const JWT_SECRET = process.env.JWT_SECRET;

function supportsAnonymousTrialPath(path = '') {
  return path === '/api/alt-text'
    || path === '/api/usage'
    || path === '/api/usage/trial-batch-plan'
    || path === '/usage'
    || path === '/api/optimizer/audit'
    || path === '/api/optimizer/history'
    || path === '/api/optimizer/progress';
}

function isPublicJobPollRequest(req) {
  return req?.method === 'GET'
    && /^\/api\/(jobs|optimizer\/audit)\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(req?.path || '');
}

// Billing and account-billing paths answer unrecognised credentials with the
// same sign-in reply the billing routes use for site-header-only callers.
const BILLING_ACCOUNT_PATHS = new Set(['/dashboard', '/me/invoices', '/me/subscriptions', '/v1/account']);
const BILLING_CHECKOUT_PATHS = new Set(['/billing/checkout', '/api/billing/checkout']);

function normalizeRoutePath(path = '') {
  const lower = String(path).toLowerCase();
  return lower.length > 1 ? lower.replace(/\/+$/, '') : lower;
}

function isBillingPath(path) {
  const normalized = normalizeRoutePath(path);
  return normalized.startsWith('/billing/')
    || normalized.startsWith('/api/billing/')
    || BILLING_ACCOUNT_PATHS.has(normalized);
}

function rejectCredentials(req, res, next, fallback) {
  // Checkout decides itself, after its own request validation, so a refusal
  // here looks and counts the same as one from the route.
  if (req.method === 'POST' && BILLING_CHECKOUT_PATHS.has(normalizeRoutePath(req.path))) {
    req.billingCredentialRejected = true;
    return next();
  }
  if (isBillingPath(req.path)) return sendSignInRequired(req, res);
  return fallback();
}

function authMiddleware({ supabase }) {
  return async function validate(req, res, next) {
    // Public paths that don't require authentication
    const publicPaths = [
      '/license/validate',
      '/license/activate',
      '/license/deactivate',
      '/license/transfer',
      '/api/license/validate',
      '/api/license/activate',
      '/api/license/deactivate',
      '/api/license/transfer',
      '/api/licenses/validate',
      '/api/licenses/activate',
      '/api/licenses/deactivate',
      '/api/licenses/transfer',
      '/billing/plans',
      '/api/billing/plans'
    ];

    // Skip auth for public paths
    if (publicPaths.includes(req.path)) {
      return next();
    }

    // Bulk submit stays licensed, but the returned UUID is the bearer handle
    // for polling progress. Some plugin clients poll without replaying headers.
    if (isPublicJobPollRequest(req)) {
      return next();
    }

    // Trial mode: only allow anonymous requests.
    // If a request has real auth credentials, it must use account quota even
    // when stale trial headers are still present.
    const trialMode = req.header('X-Trial-Mode');
    // Accept trial site hash from dedicated header OR standard site identity headers.
    // Plugins may send site identity via X-Site-Hash / X-Site-Key rather than
    // the trial-specific X-Trial-Site-Hash header.
    const trialSiteHash = req.header('X-Trial-Site-Hash')
      || req.header('X-Site-Hash')
      || req.header('X-Site-Key');
    const body = req.body || {};
    const anonymousContext = buildAnonymousContext({ req, body });
    const licenseKey = req.header('X-License-Key')
      || body.license_key
      || body.licenseKey
      || null;
    const authHeader = req.header('Authorization')
      || (body.token ? `Bearer ${body.token}` : null)
      || (body.jwt ? `Bearer ${body.jwt}` : null);
    const apiKey = req.header('X-API-Key');
    const hasBearerAuth = Boolean(authHeader && authHeader.startsWith('Bearer '));
    const allowAnonymousTrial = supportsAnonymousTrialPath(req.path)
      && trialSiteHash
      && !licenseKey
      && !apiKey
      && !hasBearerAuth
      && (trialMode === 'true' || anonymousContext.anonId);

    if (allowAnonymousTrial) {
      req.trialMode = true;
      req.trialSiteHash = trialSiteHash;
      req.anonId = anonymousContext.anonId;
      req.anonymous = anonymousContext;
      req.authMethod = 'trial';
      logger.info('[Auth] Anonymous trial request accepted', {
        site_hash: trialSiteHash,
        anon_id: anonymousContext.anonId || null,
        anon_id_source: anonymousContext.source || null,
        risk_key: anonymousContext.riskKey || null,
        source: req.header('X-Trial-Site-Hash') ? 'X-Trial-Site-Hash'
          : req.header('X-Site-Hash') ? 'X-Site-Hash' : 'X-Site-Key',
        site_url: req.header('X-Site-URL') || null,
        site_fingerprint: req.header('X-Site-Fingerprint') ? 'present' : 'absent'
      });
      return next();
    }

    // If trial mode header is present but we couldn't activate trial mode,
    // log a diagnostic so the failure is visible.
    if (trialMode === 'true' || anonymousContext.anonId) {
      logger.warn('[Auth] Anonymous trial headers present but not activated', {
        has_trial_site_hash: !!req.header('X-Trial-Site-Hash'),
        has_site_hash: !!req.header('X-Site-Hash'),
        has_site_key: !!req.header('X-Site-Key'),
        has_anon_id: !!anonymousContext.anonId,
        has_license_key: !!licenseKey,
        has_api_key: !!apiKey,
        has_bearer: hasBearerAuth,
        path: req.path,
        reason: !supportsAnonymousTrialPath(req.path) ? 'unsupported_path'
          : !trialSiteHash ? 'no_site_identity'
          : licenseKey ? 'has_license_key'
          : apiKey ? 'has_api_key'
          : hasBearerAuth ? 'has_bearer_auth' : 'unknown'
      });
    }

    // Debug logging
    logger.debug('[Auth] Request headers', {
      'X-License-Key': licenseKey ? `${licenseKey.substring(0, 8)}...` : 'missing',
      'X-API-Key': apiKey ? 'present' : 'missing',
      'Authorization': authHeader ? 'present' : 'missing',
      'X-Anon-Id': anonymousContext.anonId ? 'present' : 'missing',
      path: req.path
    });

    let jwtExpired = false;

    // JWT token auth (Bearer token)
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.substring(7);
      try {
        const decoded = jwt.verify(token, JWT_SECRET);
        logger.debug('[Auth] JWT validated', {
          user_id: decoded.user_id,
          email: decoded.email
        });

        // Fetch user from database
        if (!supabase) {
          logger.warn('[Auth] JWT auth skipped: supabase client not available');
        } else {
          const { data: user } = await supabase
            .from('licenses')
            .select('*')
            .eq('id', decoded.user_id)
            .single();

          if (user && user.status === 'active') {
            req.user = user;
            req.license = user; // Set license for quota tracking
            req.authMethod = 'jwt';
            return next();
          } else {
            logger.warn('[Auth] JWT user not found or inactive');
          }
        }
      } catch (err) {
        // A stale bearer token is common when a plugin also supplies its
        // independent licence/site/API credential. Let that credential
        // authenticate normally, without flooding warning logs.
        const isExpired = err && err.name === 'TokenExpiredError';
        jwtExpired = isExpired;
        // Public site URLs and identity hints are not proof of possession.
        const hasFallback = Boolean(licenseKey || apiKey || req.header('X-Site-Key'));
        const context = {
          reason: isExpired ? 'expired' : 'invalid',
          fallback_present: hasFallback,
          path: req.path,
          method: req.method
        };
        if (isExpired && hasFallback) {
          logger.debug('[Auth] Expired JWT; trying independent credentials', context);
        } else {
          logger.warn('[Auth] JWT validation failed', context);
        }
        // Never grant access here: the independent credential must still
        // pass its own validation below.
      }
    }

    // License-based auth preferred
    if (licenseKey) {
      const result = await validateLicense(supabase, licenseKey);
      if (result.error) {
        logger.warn('[Auth] License validation failed', {
          error: result.error,
          message: result.message,
          licenseKeyPrefix: licenseKey.substring(0, 8)
        });
        return res.status(result.status || 401).json({
          error: result.error,
          message: result.message || 'License validation failed',
          code: result.error
        });
      }
      logger.debug('[Auth] License validated', {
        plan: result.license?.plan,
        status: result.license?.status
      });
      req.license = result.license;
      req.authMethod = 'license';
      return next();
    }

    // Site-key based auth (for plugins that store the license server-side and
    // only send a site identifier). This is only as strong as the secrecy of
    // the site key; we require an active site row with a license_key.
    const siteUrl = req.header('X-Site-URL')
      || body.site_url
      || body.siteUrl
      || null;
    const siteKey = req.header('X-Site-Key')
      || req.header('X-Site-Hash')
      || req.header('X-Site-Id')
      || req.header('X-Site-ID')
      || body.site_id
      || body.siteId
      || body.siteHash
      || body.installId
      || null;
    const installUuid = req.header('X-Install-UUID')
      || req.header('X-WP-Install-UUID')
      || req.header('X-Install-Hash')
      || req.header('X-Install-Id')
      || req.header('X-Install-ID')
      || body.install_hash
      || body.installHash
      || body.install_uuid
      || body.installUuid
      || null;
    const siteFingerprint = req.header('X-Site-Fingerprint')
      || body.site_fingerprint
      || body.siteFingerprint
      || body.fingerprint
      || null;
    if ((siteKey || installUuid || siteFingerprint) && supabase) {
      try {
        const selectSite = async (column, value) => {
          if (!value) return null;
          const { data } = await supabase
            .from('sites')
            .select('license_key, status, site_hash, wp_install_uuid, site_fingerprint, fingerprint')
            .eq(column, value)
            .maybeSingle();
          return data ? { site: data, matchedBy: column } : null;
        };

        // Try in order of strongest/most specific identifiers.
        const resolved = await selectSite('wp_install_uuid', installUuid)
          || await selectSite('site_hash', siteKey)
          || await selectSite('site_fingerprint', siteFingerprint)
          || await selectSite('fingerprint', siteFingerprint);

        // A public URL can identify a site, but cannot prove account ownership.
        // Never rescue an unknown credential by looking up its claimed URL.

        const site = resolved?.site || null;
        const matchedBy = resolved?.matchedBy || null;

        if (site?.status === 'active' && site.license_key) {
          const siteLicense = await validateLicense(supabase, site.license_key);
          if (!siteLicense.error) {
            req.license = siteLicense.license;
            req.authMethod = 'site';
            logger.info('[Auth] Site-based auth resolved', {
              matchedBy,
              site_hash: site.site_hash || null,
              requestId: req.id || null,
              path: req.path
            });
            return next();
          }
          logger.warn('[Auth] Site-key resolved license invalid', {
            site_hash: site.site_hash || siteKey,
            error: siteLicense.error
          });
        }
      } catch (err) {
        logger.warn('[Auth] Site-key auth lookup failed', { error: err.message });
      }
    }

    // Fallback API token
    const requiredToken = process.env.ALT_API_TOKEN || process.env.API_TOKEN;
    if (requiredToken) {
      if (apiKey === requiredToken) {
        req.authMethod = 'api_token';
        return next();
      }
      return rejectCredentials(req, res, next, () => res.status(401).json({ error: 'INVALID_API_TOKEN', code: 'INVALID_API_TOKEN', message: 'Invalid or missing API token' }));
    }

    // A stale bearer without valid independent credentials needs sign-in,
    // not a misleading invalid-licence error or an anonymous trial downgrade.
    if (jwtExpired) {
      return res.status(401).json({
        error: 'JWT_EXPIRED', code: 'JWT_EXPIRED', retryable: false,
        message: 'Your session has expired. Please sign in again.'
      });
    }

    // Allow unauthenticated only if no token configured
    logger.warn('[Auth] No license key or API token provided', {
      path: req.path,
      method: req.method,
      headers: req.headers ? Object.keys(req.headers).filter(h => h.toLowerCase().includes('license') || h.toLowerCase().includes('api') || h.toLowerCase().includes('auth') || h.toLowerCase().includes('site') || h.toLowerCase().includes('install')) : [],
      hasBodyLicenseKey: Boolean(body.license_key || body.licenseKey),
      hasBodyToken: Boolean(body.token || body.jwt),
      hasSiteUrl: Boolean(siteUrl),
      hasSiteKey: Boolean(siteKey),
      hasInstallUuid: Boolean(installUuid),
      hasSiteFingerprint: Boolean(siteFingerprint)
    });
    return rejectCredentials(req, res, next, () => res.status(401).json({
      error: 'INVALID_LICENSE',
      code: 'INVALID_LICENSE',
      message: 'License key required. Please send X-License-Key header with your license key.',
      hint: 'Check your plugin settings to ensure the license key is configured correctly.'
    }));
  };
}

function extractUserInfo(req) {
  return {
    user_id: req.header('X-WP-User-ID') || req.header('X-User-ID') || null,
    user_email: req.header('X-WP-User-Email') || req.header('X-User-Email') || null,
    plugin_version: req.header('X-Plugin-Version') || null,
    wp_version: req.header('X-WP-Version') || null,
    php_version: req.header('X-PHP-Version') || null,
    auth_state: req.header('X-Auth-State') || null,
    plan_key: req.header('X-Plan-Key') || null,
    request_source: req.header('X-Request-Source') || null,
    plugin_channel: req.header('X-Plugin-Channel') || null,
    environment: req.header('X-Environment') || null,
    install_hash: req.header('X-Install-Hash') || req.header('X-Install-UUID') || req.header('X-WP-Install-UUID') || null
  };
}

module.exports = {
  authMiddleware,
  extractUserInfo
};
