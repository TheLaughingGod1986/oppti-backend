const { validateLicense } = require('../services/license');
const logger = require('../lib/logger');
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';

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

    // Trial mode: allow anonymous generation with per-site quota (10 max).
    const trialMode = req.header('X-Trial-Mode');
    const trialSiteHash = req.header('X-Trial-Site-Hash');
    if (trialMode === 'true' && trialSiteHash) {
      req.trialMode = true;
      req.trialSiteHash = trialSiteHash;
      req.authMethod = 'trial';
      logger.info('[Auth] Trial mode request', { site_hash: trialSiteHash });
      return next();
    }

    const licenseKey = req.header('X-License-Key');
    const authHeader = req.header('Authorization');
    const apiKey = req.header('X-API-Key');

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
      headers: req.headers ? Object.keys(req.headers).filter(h => h.toLowerCase().includes('license') || h.toLowerCase().includes('api') || h.toLowerCase().includes('auth')) : []
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
