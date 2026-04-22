const express = require('express');
const { z } = require('zod');
const logger = require('../lib/logger');
const { enforceQuota } = require('../services/quota');
const { extractUserInfo } = require('../middleware/auth');
const {
  LEDGER_SYNC_SCOPES,
  resolveImageAltStateSyncTarget,
  syncImageAltStates
} = require('../services/imageAltState');

const batchSchema = z.object({
  priority: z.enum(['high', 'normal', 'low']).optional(),
  images: z.array(z.object({
    image: z.any(),
    context: z.any().optional(),
    id: z.string().optional()
  })).min(1),
  context: z.any().optional()
});

function createJobsRouter({ supabase, checkRateLimit, getSiteFromHeaders, createJob, getJobRecord }) {
  const router = express.Router();

  function resolveAutoSyncScope(context = {}) {
    const explicitScope = [
      context?.inventory_scope,
      context?.inventoryScope,
      context?.sync_scope,
      context?.syncScope,
      context?.ledger_scope,
      context?.ledgerScope,
      context?.scope
    ].find((value) => value === LEDGER_SYNC_SCOPES.FULL_SITE || value === LEDGER_SYNC_SCOPES.PARTIAL);

    if (explicitScope) {
      return explicitScope;
    }

    const fullSiteSignals = [
      context?.full_site,
      context?.fullSite,
      context?.is_full_site_inventory,
      context?.isFullSiteInventory,
      context?.complete_inventory,
      context?.completeInventory,
      context?.selected_all,
      context?.selectedAll
    ];

    if (fullSiteSignals.some(Boolean)) {
      return LEDGER_SYNC_SCOPES.FULL_SITE;
    }

    return LEDGER_SYNC_SCOPES.PARTIAL;
  }

  async function autoSyncInventoryFromJob({
    licenseKey,
    siteHash,
    siteUrl,
    siteFingerprint,
    installUuid,
    images,
    context,
    requestId
  }) {
    if (!supabase || !licenseKey || !Array.isArray(images) || images.length === 0) {
      return;
    }

    const resolved = await resolveImageAltStateSyncTarget(supabase, {
      siteHash,
      siteUrl,
      siteFingerprint,
      installUuid,
      licenseKey
    });

    if (resolved.error || !resolved.site?.id) {
      logger.warn('[image-state] auto_sync_skipped', {
        trigger_source: 'jobs.bulk_submit',
        request_id: requestId || null,
        site_hash: siteHash || null,
        site_url: siteUrl || null,
        error: resolved.error || 'SITE_NOT_FOUND'
      });
      return;
    }

    const scope = resolveAutoSyncScope(context);
    const result = await syncImageAltStates(supabase, {
      siteId: resolved.site.id,
      siteHash: resolved.site.site_hash || siteHash || null,
      images,
      requestId,
      scope,
      allowDowngrade: false
    });

    logger.info('[image-state] auto_sync_completed', {
      trigger_source: 'jobs.bulk_submit',
      request_id: requestId || null,
      site_id: resolved.site.id,
      site_hash: resolved.site.site_hash || siteHash || null,
      scope,
      inserted: Number(result.inserted || 0),
      updated: Number(result.updated || 0),
      unchanged: Number(result.unchanged || 0),
      missing_rows_created: Number(result.missing_rows_created || 0),
      coverage_status: result.coverage?.status || null,
      snapshot_fallback_active: result.coverage?.snapshot_fallback_active ?? null,
      error_count: Array.isArray(result.errors) ? result.errors.length : 0
    });
  }

  router.post('/', async (req, res) => {
    const requestReceivedMs = Date.now();
    const parsed = batchSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'INVALID_REQUEST', details: parsed.error.flatten() });
    }
    const { priority = 'normal', images, context = {} } = parsed.data;
    const rawSiteKey = req.header('X-Site-Key') || req.header('X-Site-Hash') || null;
    const siteKey = rawSiteKey || 'default';
    const siteUrl = req.header('X-Site-URL') || null;
    const siteFingerprint = req.header('X-Site-Fingerprint') || null;
    const installUuid = req.header('X-Install-UUID') || req.header('X-WP-Install-UUID') || rawSiteKey || null;
    const licenseKey = req.header('X-License-Key') || req.license?.license_key || null;
    const userInfo = extractUserInfo(req);

    if (!licenseKey) {
      return res.status(401).json({
        error: 'LICENSE_REQUIRED',
        message: 'Bulk jobs require X-License-Key or authenticated license'
      });
    }

    // Quota check for total images (batch gate; per-item reserve still runs in processor)
    try {
      await enforceQuota(supabase, { licenseKey, siteHash: siteKey, creditsNeeded: images.length });
    } catch (err) {
      return res.status(err.status || 402).json({
        error: err.code || 'INSUFFICIENT_QUOTA',
        message: err.message,
        code: err.code || 'INSUFFICIENT_QUOTA',
        required_credits: images.length,
        credits_remaining: err.payload?.credits_remaining,
        reset_date: err.payload?.reset_date
      });
    }

    if (!(await checkRateLimit(siteKey))) {
      return res.status(429).json({ error: 'RATE_LIMIT_EXCEEDED', message: 'Rate limit exceeded', code: 'RATE_LIMIT_EXCEEDED' });
    }

    const validationCompleteMs = Date.now();
    const items = images.map(item => ({ ...item, user: userInfo }));
    const jobId = await createJob(items, { ...context, priority }, siteKey, {
      licenseKey,
      userInfo
    });

    logger.info('[jobs] bulk_job_accepted', {
      job_id: jobId,
      total_images: images.length,
      site_key: siteKey,
      validation_ms: validationCompleteMs - requestReceivedMs,
      dispatch: process.env.BULK_JOB_DISPATCH || 'immediate'
    });

    setImmediate(() => {
      autoSyncInventoryFromJob({
        licenseKey,
        siteHash: rawSiteKey,
        siteUrl,
        siteFingerprint,
        installUuid,
        images,
        context,
        requestId: req.id || null
      }).catch((error) => {
        logger.error('[image-state] auto_sync_failed', {
          trigger_source: 'jobs.bulk_submit',
          request_id: req.id || null,
          site_hash: rawSiteKey || null,
          error: error?.message || String(error)
        });
      });
    });

    res.status(202).json({
      jobId,
      status: 'accepted',
      total: images.length,
      completed: 0,
      failed: 0,
      priority,
      pollUrl: `/api/jobs/${jobId}`,
      timings: {
        validation_ms: validationCompleteMs - requestReceivedMs
      }
    });
  });

  router.get('/:jobId', async (req, res) => {
    const job = await getJobRecord(req.params.jobId);
    if (!job) return res.status(404).json({ error: 'JOB_NOT_FOUND', message: 'Job not found' });
    const percentComplete = job.total
      ? Math.round(((job.completed || 0) + (job.failed || 0)) / job.total * 100)
      : 0;
    res.json({
      ...job,
      percentComplete
    });
  });

  return router;
}

module.exports = { createJobsRouter };
