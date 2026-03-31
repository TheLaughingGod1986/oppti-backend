const { validateLicense } = require('../services/license');
const logger = require('../lib/logger');
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;

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
      '/billing/plans'
    ];

    // Skip auth for public paths
    if (publicPaths.includes(req.path)) {
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
    const licenseKey = req.header('X-License-Key')
      || body.license_key
      || body.licenseKey
      || null;
    const authHeader = req.header('Authorization')
      || (body.token ? `Bearer ${body.token}` : null)
      || (body.jwt ? `Bearer ${body.jwt}` : null);
    const apiKey = req.header('X-API-Key');
    const hasBearerAuth = Boolean(authHeader && authHeader.startsWith('Bearer '));
    if (trialMode === 'true' && trialSiteHash && !licenseKey && !apiKey && !hasBearerAuth) {
      req.trialMode = true;
      req.trialSiteHash = trialSiteHash;
      req.authMethod = 'trial';
      logger.info('[Auth] Trial mode request', {
        site_hash: trialSiteHash,
        source: req.header('X-Trial-Site-Hash') ? 'X-Trial-Site-Hash'
          : req.header('X-Site-Hash') ? 'X-Site-Hash' : 'X-Site-Key',
        site_url: req.header('X-Site-URL') || null,
        site_fingerprint: req.header('X-Site-Fingerprint') ? 'present' : 'absent'
      });
      return next();
    }

    // If trial mode header is present but we couldn't activate trial mode,
    // log a diagnostic so the failure is visible.
    if (trialMode === 'true') {
      logger.warn('[Auth] Trial mode header present but not activated', {
        has_trial_site_hash: !!req.header('X-Trial-Site-Hash'),
        has_site_hash: !!req.header('X-Site-Hash'),
        has_site_key: !!req.header('X-Site-Key'),
        has_license_key: !!licenseKey,
        has_api_key: !!apiKey,
        has_bearer: hasBearerAuth,
        reason: !trialSiteHash ? 'no_site_identity'
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
      path: req.path
    });

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
      } catch (err) {
        logger.warn('[Auth] JWT validation failed', { error: err.message });
        // Don't return error, fall through to other auth methods
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
      || req.header('X-Install-Id')
      || req.header('X-Install-ID')
      || body.install_uuid
      || body.installUuid
      || null;
    const siteFingerprint = req.header('X-Site-Fingerprint')
      || body.site_fingerprint
      || body.siteFingerprint
      || body.fingerprint
      || null;
    if ((siteKey || installUuid || siteFingerprint || siteUrl) && supabase) {
      try {
        const selectSite = async (column, value) => {
          if (!value) return null;
          const { data } = await supabase
            .from('sites')
            .select('license_key, status, site_hash, wp_install_uuid, site_fingerprint, fingerprint')
            .eq(column, value)
            .maybeSingle();
          return data || null;
        };

        const selectSiteByUrl = async (rawUrl) => {
          if (!rawUrl || typeof rawUrl !== 'string') return null;
          const trimmed = rawUrl.trim();
          if (!trimmed) return null;

          // Try exact match first (fast path).
          const exact = await selectSite('site_url', trimmed);
          if (exact) return exact;

          // Fall back to hostname match (protocol/trailing slash differences).
          let hostname = null;
          try {
            const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
            hostname = new URL(candidate).hostname;
          } catch (_err) {
            hostname = null;
          }
          if (!hostname) return null;

          // Best-effort: match any active site row containing the hostname.
          const { data } = await supabase
            .from('sites')
            .select('license_key, status, site_hash, wp_install_uuid, site_fingerprint, fingerprint')
            .eq('status', 'active')
            .ilike('site_url', `%${hostname}%`)
            .order('last_seen_at', { ascending: false, nullsFirst: false })
            .limit(1);
          return Array.isArray(data) && data.length ? data[0] : null;
        };

        // Try in order of strongest/most specific identifiers.
        const site = await selectSite('wp_install_uuid', installUuid)
          || await selectSite('site_hash', siteKey)
          || await selectSite('site_fingerprint', siteFingerprint)
          || await selectSite('fingerprint', siteFingerprint)
          || await selectSiteByUrl(siteUrl);

        if (site?.status === 'active' && site.license_key) {
          const siteLicense = await validateLicense(supabase, site.license_key);
          if (!siteLicense.error) {
            req.license = siteLicense.license;
            req.authMethod = 'site';
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
      return res.status(401).json({ error: 'INVALID_API_TOKEN', message: 'Invalid or missing API token' });
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
    return res.status(401).json({ 
      error: 'INVALID_LICENSE', 
      message: 'License key required. Please send X-License-Key header with your license key.',
      hint: 'Check your plugin settings to ensure the license key is configured correctly.'
    });
  };
}

function extractUserInfo(req) {
  return {
    user_id: req.header('X-WP-User-ID') || req.header('X-User-ID') || null,
    user_email: req.header('X-WP-User-Email') || req.header('X-User-Email') || null,
    plugin_version: req.header('X-Plugin-Version') || null
  };
}

module.exports = {
  authMiddleware,
  extractUserInfo
};
