const logger = require('../lib/logger');

function isUuid(value) {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

/**
 * Resolve which backend user_id (licenses.id) should be used for usage_logs.user_id.
 *
 * Priority:
 * 1) authenticated backend user id (req.user/req.license; jwt/session)
 * 2) sites.owner_user_id via site_hash
 * 3) license owner user id (licenses.id / usage_logs.license_id)
 * 4) null + attribution_missing reason
 */
async function resolveUsageAttributionUserId(supabase, {
  req = null,
  siteHash = null,
  effectiveSite = null,
  licenseId = null
} = {}) {
  const authUserId = req?.user?.id || req?.license?.id || null;
  if (isUuid(authUserId)) {
    return {
      userId: authUserId,
      source: req?.authMethod === 'jwt' ? 'jwt' : 'authenticated',
      reason: null
    };
  }

  const siteOwnerUserId = effectiveSite?.owner_user_id || null;
  if (isUuid(siteOwnerUserId)) {
    return { userId: siteOwnerUserId, source: 'site_owner', reason: null };
  }

  if (supabase && siteHash) {
    try {
      const { data, error } = await supabase
        .from('sites')
        .select('owner_user_id')
        .eq('site_hash', siteHash)
        .maybeSingle();
      if (!error && isUuid(data?.owner_user_id)) {
        return { userId: data.owner_user_id, source: 'site_owner', reason: null };
      }
    } catch (err) {
      logger.debug('[usage] attribution_site_owner_lookup_failed', {
        site_hash: siteHash || null,
        error: err?.message || String(err)
      });
    }
  }

  if (isUuid(licenseId)) {
    return { userId: licenseId, source: 'license_owner', reason: null };
  }

  return {
    userId: null,
    source: 'missing',
    reason: !siteHash ? 'no_site_hash'
      : !supabase ? 'no_supabase'
      : 'no_auth_and_no_owner'
  };
}

module.exports = {
  resolveUsageAttributionUserId,
  isUuid
};

