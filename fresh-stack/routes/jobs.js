const express = require('express');
const { z } = require('zod');
const logger = require('../lib/logger');
const { enforceQuota } = require('../services/quota');
const { extractUserInfo } = require('../middleware/auth');

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

  router.post('/', async (req, res) => {
    const requestReceivedMs = Date.now();
    const parsed = batchSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'INVALID_REQUEST', details: parsed.error.flatten() });
    }
    const { priority = 'normal', images, context = {} } = parsed.data;
    const siteKey = req.header('X-Site-Key') || req.header('X-Site-Hash') || 'default';
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
