const express = require('express');
const { z } = require('zod');
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
    const parsed = batchSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'INVALID_REQUEST', details: parsed.error.flatten() });
    }
    const { priority = 'normal', images, context = {} } = parsed.data;
    const siteKey = req.header('X-Site-Key') || 'default';
    const licenseKey = req.header('X-License-Key') || req.license?.license_key || null;
    const userInfo = extractUserInfo(req);

    // Quota check for total images
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

    const items = images.map(item => ({ ...item, user: userInfo }));
    const jobId = await createJob(items, { ...context, priority }, siteKey);
    res.status(202).json({
      jobId,
      status: 'processing',
      total: images.length,
      completed: 0,
      failed: 0,
      priority
    });
  });

  router.get('/:jobId', async (req, res) => {
    const job = await getJobRecord(req.params.jobId);
    if (!job) return res.status(404).json({ error: 'JOB_NOT_FOUND', message: 'Job not found' });
    res.json(job);
  });

  return router;
}

module.exports = { createJobsRouter };
