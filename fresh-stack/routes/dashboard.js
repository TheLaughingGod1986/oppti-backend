const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { z } = require('zod');
const logger = require('../lib/logger');
const { getQuotaStatus } = require('../services/quota');
const { buildEntitlementState } = require('../services/entitlementState');
const { getUsageLogs } = require('../services/usage');
const { buildDashboardStateTruth } = require('../services/dashboardStateTruth');
const {
  resolveImageAltStateSiteContext,
  syncImageAltStates
} = require('../services/imageAltState');

const imageStateSyncItemSchema = z.object({
  attachment_id: z.union([z.string(), z.number()]).optional(),
  attachmentId: z.union([z.string(), z.number()]).optional(),
  image_id: z.union([z.string(), z.number()]).optional(),
  imageId: z.union([z.string(), z.number()]).optional(),
  media_id: z.union([z.string(), z.number()]).optional(),
  mediaId: z.union([z.string(), z.number()]).optional(),
  image_url: z.string().optional(),
  imageUrl: z.string().optional(),
  filename: z.string().optional(),
  fileName: z.string().optional(),
  alt_text: z.string().optional(),
  altText: z.string().optional(),
  current_state: z.string().optional(),
  currentState: z.string().optional(),
  force_state: z.boolean().optional(),
  forceState: z.boolean().optional(),
  image: z.object({}).passthrough().optional(),
  context: z.object({}).passthrough().optional(),
  metadata: z.object({}).passthrough().optional(),
  last_generated_at: z.string().optional(),
  lastGeneratedAt: z.string().optional(),
  last_reviewed_at: z.string().optional(),
  lastReviewedAt: z.string().optional()
});

const imageStateSyncSchema = z.object({
  scope: z.enum(['full_site', 'partial']).optional(),
  allow_downgrade: z.boolean().optional(),
  allowDowngrade: z.boolean().optional(),
  images: z.array(imageStateSyncItemSchema).min(1).max(500).optional(),
  items: z.array(imageStateSyncItemSchema).min(1).max(500).optional()
}).superRefine((value, ctx) => {
  if ((!Array.isArray(value.images) || value.images.length === 0) && (!Array.isArray(value.items) || value.items.length === 0)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['images'],
      message: 'images array is required'
    });
  }
});

function summarizeSyncItemsForLog(items = [], limit = 3) {
  return (Array.isArray(items) ? items : [])
    .slice(0, Math.max(1, limit))
    .map((item) => ({
      attachment_id: item?.attachment_id || item?.attachmentId || item?.image_id || item?.imageId || null,
      current_state: item?.current_state || item?.currentState || null,
      image_url: item?.image_url || item?.imageUrl || item?.image?.url || null,
      filename: item?.filename || item?.fileName || item?.image?.filename || null
    }));
}

function createDashboardRouter({ supabase, getJobRecord = null }) {
  const router = express.Router();

  // GET /dashboard/state-truth
  router.get('/state-truth', async (req, res) => {
    const licenseKey = req.header('X-License-Key') || req.license?.license_key || req.user?.license_key || null;
    if (!licenseKey && !req.license && !req.user) {
      return res.status(401).json({
        success: false,
        error: 'INVALID_LICENSE',
        code: 'INVALID_LICENSE',
        message: 'License key or authenticated account required'
      });
    }

    const payload = await buildDashboardStateTruth({
      supabase,
      req,
      getJobRecord
    });

    return res.json(payload);
  });

  // POST /dashboard/image-states/sync
  router.post('/image-states/sync', async (req, res) => {
    const parsed = imageStateSyncSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        error: 'INVALID_REQUEST',
        message: 'images array is required',
        details: parsed.error.flatten()
      });
    }

    const images = Array.isArray(parsed.data.images) && parsed.data.images.length > 0
      ? parsed.data.images
      : (Array.isArray(parsed.data.items) ? parsed.data.items : []);

    logger.info('[dashboard] image_state_sync_received', {
      request_id: req.id || null,
      image_count: images.length,
      scope: parsed.data.scope || 'full_site',
      payload_shape: Array.isArray(parsed.data.images) && parsed.data.images.length > 0 ? 'images' : 'items',
      request_site_hash: req.header('X-Site-Key') || req.header('X-Site-Hash') || req.body?.site_hash || req.body?.site_id || null,
      request_site_url: req.header('X-Site-URL') || req.body?.site_url || null,
      sample_items: summarizeSyncItemsForLog(images)
    });

    const resolved = await resolveImageAltStateSiteContext(supabase, req, {
      createIfMissing: true
    });

    if (resolved.error || !resolved.site?.id) {
      logger.warn('[dashboard] image_state_sync_site_resolution_failed', {
        request_id: req.id || null,
        error: resolved.error || 'SITE_NOT_FOUND',
        request_site_hash: req.header('X-Site-Key') || req.header('X-Site-Hash') || req.body?.site_hash || req.body?.site_id || null,
        request_site_url: req.header('X-Site-URL') || req.body?.site_url || null
      });
      return res.status(resolved.error === 'INVALID_SITE_IDENTITY' ? 400 : 404).json({
        success: false,
        error: resolved.error || 'SITE_NOT_FOUND',
        message: resolved.error === 'INVALID_SITE_IDENTITY'
          ? 'Valid site identity is required for image state sync.'
          : 'Canonical site not found for image state sync.'
      });
    }

    logger.info('[dashboard] image_state_sync_site_resolved', {
      request_id: req.id || null,
      site_id: resolved.site.id,
      site_hash: resolved.site.site_hash || null,
      matched_by: resolved.matchedBy || null,
      created: Boolean(resolved.created)
    });

    const result = await syncImageAltStates(supabase, {
      siteId: resolved.site.id,
      siteHash: resolved.site.site_hash || null,
      images,
      requestId: req.id || null,
      scope: parsed.data.scope || 'full_site',
      allowDowngrade: Boolean(parsed.data.allow_downgrade || parsed.data.allowDowngrade)
    });

    logger.info('[dashboard] image_state_sync_completed', {
      request_id: req.id || null,
      site_id: resolved.site.id,
      site_hash: resolved.site.site_hash || null,
      changed_count: result.count,
      inserted: Number(result.inserted || 0),
      updated: Number(result.updated || 0),
      unchanged: Number(result.unchanged || 0),
      error_count: Array.isArray(result.errors) ? result.errors.length : 0,
      coverage_status: result.coverage?.status || null
    });

    return res.json({
      success: true,
      data: {
        site_id: resolved.site.id,
        site_hash: resolved.site.site_hash || null,
        updated: Number(result.updated || 0),
        inserted: Number(result.inserted || 0),
        changed: result.count,
        unchanged: Number(result.unchanged || 0),
        missing_rows_created: Number(result.missing_rows_created || 0),
        duplicate_input_rows: Number(result.duplicate_input_rows || 0),
        orphaned_existing_rows: Number(result.orphaned_existing_rows || 0),
        counts_by_state: result.coverage?.state_counts || null,
        dashboard_counts: result.dashboard_counts || null,
        coverage: result.coverage || null,
        errors: result.errors || []
      }
    });
  });

  // POST /dashboard/login
  router.post('/login', async (req, res) => {
    const { email, password } = req.body || {};
    const { data: license } = await supabase
      .from('licenses')
      .select('*')
      .eq('email', email)
      .single();

    if (!license) return res.status(401).json({ error: 'INVALID_CREDENTIALS', message: 'Invalid email or password' });

    if (license.password_hash) {
      const ok = await bcrypt.compare(password || '', license.password_hash);
      if (!ok) return res.status(401).json({ error: 'INVALID_CREDENTIALS', message: 'Invalid email or password' });
    }

    const sessionToken = crypto.randomUUID();
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7);

    const { error: sessionError } = await supabase.from('dashboard_sessions').insert({
      license_key: license.license_key,
      session_token: sessionToken,
      expires_at: expiresAt.toISOString()
    });

    if (sessionError) {
      logger.error('[session] dashboard_session_create_failed', {
        table: 'dashboard_sessions',
        success: false,
        license_key_prefix: license.license_key ? `${license.license_key.substring(0, 8)}...` : null,
        email: license.email || null,
        error: sessionError.message
      });
      return res.status(500).json({
        error: 'SESSION_CREATE_FAILED',
        message: sessionError.message || 'Failed to create dashboard session'
      });
    }

    logger.info('[session] dashboard_session_create_succeeded', {
      table: 'dashboard_sessions',
      success: true,
      license_key_prefix: license.license_key ? `${license.license_key.substring(0, 8)}...` : null,
      email: license.email || null,
      expires_at: expiresAt.toISOString()
    });

    return res.json({ session_token: sessionToken, expires_at: expiresAt.toISOString() });
  });

  // POST /dashboard/logout
  router.post('/logout', async (req, res) => {
    const token = req.header('Authorization')?.replace(/^Bearer\s+/i, '') || req.body?.session_token;
    if (!token) return res.status(400).json({ error: 'INVALID_REQUEST', message: 'Missing session token' });
    await supabase.from('dashboard_sessions').delete().eq('session_token', token);
    return res.json({ success: true });
  });

  // GET /dashboard/stats
  router.get('/stats', async (req, res) => {
    const token = req.header('Authorization')?.replace(/^Bearer\s+/i, '');
    const session = await supabase
      .from('dashboard_sessions')
      .select('license_key, expires_at')
      .eq('session_token', token)
      .single();
    if (session.error || !session.data) return res.status(401).json({ error: 'INVALID_SESSION' });

    const licenseKey = session.data.license_key;
    const quota = await getQuotaStatus(supabase, { licenseKey });
    if (quota.error) return res.status(quota.status || 500).json(quota);

    return res.json({
      license_key: licenseKey,
      entitlement_state: buildEntitlementState(quota, {
        isLoggedIn: true,
        isTrial: false
      }),
      credits_used: quota.credits_used,
      credits_remaining: quota.credits_remaining,
      total_limit: quota.total_limit,
      reset_date: quota.reset_date,
      plan_type: quota.plan_type
    });
  });

  // GET /dashboard/logs
  // Deprecated: structured application logs and admin diagnostics are now the
  // real observability surface. Keep the session check so old clients receive
  // an explicit deprecation response instead of a misleading empty log feed.
  router.get('/logs', async (req, res) => {
    const token = req.header('Authorization')?.replace(/^Bearer\s+/i, '');
    const session = await supabase
      .from('dashboard_sessions')
      .select('license_key')
      .eq('session_token', token)
      .single();
    if (session.error || !session.data) return res.status(401).json({ error: 'INVALID_SESSION' });

    const licenseKey = session.data.license_key;
    logger.info('[dashboard] logs_route_deprecated', {
      request_id: req.id || null,
      license_key_prefix: licenseKey ? `${licenseKey.substring(0, 8)}...` : null
    });

    return res.status(410).json({
      success: false,
      error: 'DASHBOARD_LOGS_DEPRECATED',
      message: 'Dashboard database logs are no longer available. Use admin diagnostics and structured application logs instead.',
      deprecated: true,
      logs: [],
      data: {
        logs: [],
        source: 'diagnostics_and_app_logs',
        deprecated: true
      }
    });
  });

  // GET /dashboard/usage/export - simple CSV of usage logs
  router.get('/usage/export', async (req, res) => {
    const token = req.header('Authorization')?.replace(/^Bearer\s+/i, '');
    const session = await supabase
      .from('dashboard_sessions')
      .select('license_key')
      .eq('session_token', token)
      .single();
    if (session.error || !session.data) return res.status(401).json({ error: 'INVALID_SESSION' });
    const licenseKey = session.data.license_key;

    const logsResult = await getUsageLogs(supabase, { licenseKey, limit: 500 });
    if (logsResult.error) return res.status(500).json({ error: 'SERVER_ERROR', message: logsResult.error.message });
    const logs = logsResult.data || [];
    const header = ['created_at', 'site_hash', 'user_email', 'credits_used', 'endpoint', 'status'];
    const csvLines = [header.join(',')];
    logs.forEach((log) => {
      csvLines.push([
        log.created_at,
        log.site_hash,
        log.user_email,
        log.credits_used,
        log.endpoint,
        log.status
      ].join(','));
    });
    res.setHeader('Content-Type', 'text/csv');
    res.send(csvLines.join('\n'));
  });

  return router;
}

module.exports = { createDashboardRouter };
