const express = require('express');
const { validateLicense, activateLicense, deactivateLicense, transferLicense, getLicenseDetails } = require('../services/license');
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
    return res.json({ valid: true, license: result.license });
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
      plan: license.plan || license.plan_type || 'free',
      status: license.status || 'active',
      max_sites: license.max_sites ?? 1,
      license_key: license.license_key
    };
    return res.json({
      success: true,
      message: 'License activated successfully',
      license: result.license,
      site: result.site,
      organization,
      data: { organization, site: result.site }
    });
  });

  router.post('/deactivate', async (req, res) => {
    const { license_key, site_id } = normalizeDeactivateBody(req.body);
    const result = await deactivateLicense(supabase, { licenseKey: license_key, siteHash: site_id });
    if (result.error) {
      return res.status(result.status || 400).json(result);
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
      return res.status(result.status || 400).json(result);
    }
    return res.json({ success: true, message: 'License transferred', license: result.license, site: result.site });
  });

  router.get('/sites', async (req, res) => {
    const licenseKey = req.header('X-License-Key') || req.license?.license_key;
    if (!licenseKey) {
      return res.status(401).json({ error: 'INVALID_LICENSE', message: 'X-License-Key header required' });
    }
    const result = await getSites(supabase, { licenseKey });
    if (result.error) return res.status(500).json({ error: 'SERVER_ERROR', message: result.error.message });
    return res.json({
      success: true,
      license_key: licenseKey,
      sites: result.data || [],
      data: { sites: result.data || [] }
    });
  });

  router.delete('/sites/:site_id', async (req, res) => {
    const licenseKey = req.header('X-License-Key') || req.license?.license_key;
    const siteHash = req.params.site_id;
    if (!licenseKey || !siteHash) {
      return res.status(400).json({ error: 'INVALID_REQUEST', message: 'License key and site ID required' });
    }
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

  router.post('/sites/:site_id/quota', async (req, res) => {
    const licenseKey = req.header('X-License-Key') || req.body?.license_key;
    const siteHash = req.params.site_id;
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
      site: result.data
    });
  });

  return router;
}

module.exports = { createLicenseRouter };
