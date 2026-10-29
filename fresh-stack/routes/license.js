const express = require('express');
const { requireAccountCredential } = require('../lib/accountCredential');
const logger = require('../lib/logger');
const { siteRefForLog } = require('../lib/logIdentity');
const { publicSite, publicSites, isAccountCredential } = require('../lib/publicSite');
const { buildSiteIdentity } = require('../lib/siteIdentity');
const { fetchAccountByLicenseKey, resolveCanonicalSite } = require('../services/siteQuota');
const { validateLicense, activateLicense, deactivateLicense, transferLicense, sanitizeLicense } = require('../services/license');
const { setSiteQuota, getSites, deactivateSite } = require('../services/site');

/**
 * Normalize request body: accept both camelCase (frontend) and snake_case (backend).
 */
function normalizeActivateBody(body) {
  const b = body || {};
  return {
    license_key: b.license_key ?? b.licenseKey,
    site_id: b.site_id ?? b.siteHash ?? b.installId,
    site_url: b.site_url ?? b.siteUrl,
    site_name: b.site_name ?? b.siteName,
    fingerprint: b.fingerprint ?? b.site_fingerprint
  };
}

function normalizeDeactivateBody(body) {
  const b = body || {};
  return {
    license_key: b.license_key ?? b.licenseKey,
    site_id: b.site_id ?? b.siteHash ?? b.siteId
  };
}

// The :site_id path segment of the per-site licence routes may be the sites
// row id or the site's raw key (older clients). A row id resolves to that
// row's key only when the row is on the caller's licence or owned by the
// caller; anything else is used as given. The raw key is never logged.
async function siteKeyFromPathId(supabase, pathId, { licenseKey, account } = {}) {
  if (!supabase || !pathId) return pathId;
  try {
    const { data, error } = await supabase
      .from('sites')
      .select('id, site_hash, license_key, owner_user_id')
      .eq('id', pathId)
      .maybeSingle();
    if (error || !data?.site_hash) return pathId;
    const onLicence = Boolean(licenseKey) && data.license_key === licenseKey;
    const owned = Boolean(account?.id) && data.owner_user_id === account.id;
    return onLicence || owned ? data.site_hash : pathId;
  } catch (_error) {
    // Not a row id (for example not a uuid): treat it as the raw key.
    return pathId;
  }
}

function createLicenseRouter({ supabase }) {
  const router = express.Router();

  router.post('/validate', async (req, res) => {
    const body = req.body || {};
    const license_key = body.license_key ?? body.licenseKey;
    const result = await validateLicense(supabase, license_key);
    if (result.error) {
      return res.status(result.status || 401).json({
        valid: false,
        error: result.error.toLowerCase(),
        message: result.message,
        code: result.error
      });
    }
    return res.json({ valid: true, license: sanitizeLicense(result.license) });
  });

  router.post('/activate', async (req, res) => {
    const { license_key, site_id, site_url, site_name, fingerprint } = normalizeActivateBody(req.body);
    const result = await activateLicense(supabase, {
      licenseKey: license_key,
      siteHash: site_id,
      siteUrl: site_url,
      siteName: site_name,
      fingerprint
    });
    if (result.error) {
      return res.status(result.status || 400).json({
        success: false,
        error: result.error.toLowerCase(),
        message: result.message,
        code: result.error,
        activated_site: result.activated_site,
        max_sites: result.max_sites,
        activated_sites: result.activated_sites
      });
    }
    // Frontend expects organization and site; organization = license/plan info
    const license = result.license || {};
    const organization = {
      id: license.id ?? null,
      plan: license.plan || 'free',
      status: license.status || 'active',
      max_sites: license.max_sites ?? 1,
      license_key: license.license_key
    };
    return res.json({
      success: true,
      message: 'License activated successfully',
      license: sanitizeLicense(result.license),
      site: publicSite(result.site, { accountCredential: true }),
      organization,
      data: { organization, site: publicSite(result.site, { accountCredential: true }) }
    });
  });

  router.post('/deactivate', async (req, res) => {
    const { license_key, site_id } = normalizeDeactivateBody(req.body);
    const result = await deactivateLicense(supabase, { licenseKey: license_key, siteHash: site_id });
    if (result.error) {
      const safe = { ...result };
      delete safe.license;
      return res.status(result.status || 400).json(safe);
    }
    return res.json({ success: true, message: 'License deactivated successfully' });
  });

  router.post('/transfer', async (req, res) => {
    const { license_key, old_site_id, new_site_id, new_fingerprint, new_site_url, new_site_name } = req.body || {};
    const result = await transferLicense(supabase, {
      licenseKey: license_key,
      oldSiteId: old_site_id,
      newSiteId: new_site_id,
      newFingerprint: new_fingerprint,
      newSiteUrl: new_site_url,
      newSiteName: new_site_name
    });
    if (result.error) {
      const safe = { ...result };
      delete safe.license;
      return res.status(result.status || 400).json(safe);
    }
    return res.json({ success: true, message: 'License transferred', license: sanitizeLicense(result.license), site: publicSite(result.site, { accountCredential: true }) });
  });

  // The site list (and the licence it belongs to) needs an account
  // credential; a site key alone gets the sign-in reply.
  router.get('/sites', requireAccountCredential, async (req, res) => {
    const licenseKey = req.header('X-License-Key') || req.license?.license_key;
    if (!licenseKey) {
      return res.status(401).json({ error: 'INVALID_LICENSE', message: 'X-License-Key header required' });
    }

    const rawSiteKey = req.header('X-Site-Key') || req.header('X-Site-Hash') || null;
    const siteIdentity = buildSiteIdentity({
      siteHash: rawSiteKey,
      installUuid: req.header('X-Install-UUID')
        || req.header('X-WP-Install-UUID')
        || rawSiteKey
        || null,
      siteUrl: req.header('X-Site-URL') || null,
      siteFingerprint: req.header('X-Site-Fingerprint') || null,
      allowDevelopment: true
    });

    if (siteIdentity.isValid) {
      const account = req.user || req.license || await fetchAccountByLicenseKey(supabase, licenseKey);
      logger.info('[site] license_sites_healing_attempted', {
        request_id: req.id || null,
        account_id: account?.id || null,
        has_license_key: Boolean(licenseKey),
        ...siteRefForLog(siteIdentity.siteHash || null, req),
        site_url: siteIdentity.siteUrl || null,
        site_fingerprint_present: Boolean(siteIdentity.siteFingerprint)
      });

      const healed = await resolveCanonicalSite(supabase, siteIdentity, {
        createIfMissing: true,
        legacyLicenseKey: licenseKey,
        account,
        requestId: req.id || null
      });

      if (healed.error) {
        logger.error('[site] license_sites_healing_failed', {
          request_id: req.id || null,
          account_id: account?.id || null,
          has_license_key: Boolean(licenseKey),
          ...siteRefForLog(siteIdentity.siteHash || null, req),
          site_url: siteIdentity.siteUrl || null,
          error: healed.error,
          site_write_error: healed.diagnostics?.site_write_error || null,
          membership_error: healed.diagnostics?.membership?.error || null
        });
      } else {
        logger.info('[site] license_sites_healing_succeeded', {
          request_id: req.id || null,
          account_id: account?.id || null,
          has_license_key: Boolean(licenseKey),
          site_id: healed.site?.id || null,
          ...siteRefForLog(healed.site?.site_hash || siteIdentity.siteHash || null, req),
          matched_by: healed.matchedBy || null,
          created: Boolean(healed.created),
          membership_attempted: Boolean(healed.diagnostics?.membership?.attempted),
          membership_success: healed.diagnostics?.membership?.success ?? null
        });
      }
    }

    const result = await getSites(supabase, { licenseKey });
    if (result.error) return res.status(500).json({ error: 'SERVER_ERROR', message: result.error.message });
    // Site rows never carry the raw site key; the licence key is echoed
    // only to a caller that authenticated with an account credential.
    const sites = publicSites(result.data || [], { accountCredential: isAccountCredential(req) });
    return res.json({
      success: true,
      ...(isAccountCredential(req) ? { license_key: licenseKey } : {}),
      sites,
      data: { sites }
    });
  });

  // Disconnect and per-site quota change the account's sites: account
  // credential only (Chief's ruling, 29 Oct). No shipped plugin calls either
  // with site headers alone (Alt Text 4.6.143/4.6.144 send the licence key or
  // token on DELETE; nothing calls quota).
  router.delete('/sites/:site_id', requireAccountCredential, async (req, res) => {
    const account = req.license || req.user || null;
    const licenseKey = req.license?.license_key || req.user?.license_key || req.header('X-License-Key');
    const pathId = req.params.site_id;
    if (!licenseKey || !pathId) {
      return res.status(400).json({ error: 'INVALID_REQUEST', message: 'License key and site ID required' });
    }
    const siteHash = await siteKeyFromPathId(supabase, pathId, { licenseKey, account });
    const result = await deactivateSite(supabase, { licenseKey, siteHash });
    if (result.error) {
      return res.status(result.status || 400).json({
        success: false,
        error: result.error,
        message: result.message
      });
    }
    return res.json({
      success: true,
      message: 'Site disconnected successfully',
      data: { message: 'Site disconnected successfully' }
    });
  });

  router.post('/sites/:site_id/quota', requireAccountCredential, async (req, res) => {
    const account = req.license || req.user || null;
    const licenseKey = req.license?.license_key || req.user?.license_key || req.header('X-License-Key');
    const siteHash = await siteKeyFromPathId(supabase, req.params.site_id, { licenseKey, account });
    const { quota_limit } = req.body || {};
    const result = await setSiteQuota(supabase, { licenseKey, siteHash, quotaLimit: quota_limit });
    if (result.error) {
      return res.status(result.status || 400).json({
        success: false,
        error: result.error,
        message: result.message,
        code: result.error
      });
    }
    return res.json({
      success: true,
      message: 'Site quota updated successfully',
      site: publicSite(result.data, { accountCredential: isAccountCredential(req) })
    });
  });

  return router;
}

module.exports = { createLicenseRouter, siteKeyFromPathId };
