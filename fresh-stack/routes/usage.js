const express = require('express');
const { getQuotaStatus } = require('../services/quota');
const { getUserUsage, getSiteUsage, getPeriodBounds } = require('../services/usage');

async function countLegacyTrialUsage(supabase, siteHash) {
  if (!supabase || !siteHash) return null;
  const { count, error } = await supabase
    .from('trial_usage')
    .select('id', { count: 'exact', head: true })
    .eq('site_hash', siteHash);
  if (error) return null;
  return Number(count || 0);
}

async function buildTrialStatus(supabase, status, siteHash) {
  const trialLimit = 3;
  const usedFromV2 = status?.trial?.used_trial_credits;
  const used = Number.isFinite(Number(usedFromV2))
    ? Number(usedFromV2)
    : await countLegacyTrialUsage(supabase, siteHash);

  if (!Number.isFinite(Number(used))) {
    return null;
  }

  const trial_used = Math.max(Number(used) || 0, 0);
  const trial_remaining = Math.max(trialLimit - trial_used, 0);
  const trial_exhausted = trial_used >= trialLimit;
  return { trial_used, trial_remaining, trial_exhausted, trial_limit: trialLimit };
}

function createUsageRouter({ supabase }) {
  const router = express.Router();

  // GET /usage - current quota status
  router.get('/', async (req, res) => {
    const licenseKey = req.header('X-License-Key') || req.license?.license_key;
    // Trial mode requests only send X-Trial-Site-Hash (see auth middleware).
    // Always treat backend quota/trial status as authoritative.
    const siteKey = req.trialMode
      ? req.trialSiteHash
      : (req.header('X-Site-Key') || req.header('X-Site-Hash'));
    const siteUrl = req.header('X-Site-URL') || null;
    const siteFingerprint = req.header('X-Site-Fingerprint') || null;

    const status = await getQuotaStatus(supabase, {
      account: req.user || req.license || null,
      licenseKey,
      siteHash: siteKey,
      siteUrl,
      siteFingerprint,
      installUuid: siteKey,
      requestId: req.id || null
    });

    // For trial mode, quota status may fail (no license) — that's expected.
    // Build trial status directly from trial_usage table as authoritative source.
    if (req.trialMode) {
      const trial = status.error
        ? await buildTrialStatus(supabase, {}, siteKey)
        : await buildTrialStatus(supabase, status, siteKey);

      const trialInfo = trial || { trial_used: 0, trial_remaining: 3, trial_exhausted: false, trial_limit: 3 };
      return res.json({
        success: true,
        data: {
          usage: {
            used: trialInfo.trial_used,
            remaining: trialInfo.trial_remaining,
            limit: trialInfo.trial_limit,
            plan: 'trial',
            plan_type: 'trial',
            billing_cycle: 'trial',
            trial: trialInfo
          },
          credits_used: trialInfo.trial_used,
          credits_remaining: trialInfo.trial_remaining,
          total_limit: trialInfo.trial_limit,
          plan_type: 'trial',
          ...trialInfo
        }
      });
    }

    if (status.error) {
      return res.status(status.status || 401).json(status);
    }

    const trial = await buildTrialStatus(supabase, status, siteKey);

    // Return in format expected by plugin
    return res.json({
      success: true,
      data: {
        usage: {
          used: status.credits_used,
          remaining: status.credits_remaining,
          limit: status.total_limit,
          plan: status.plan_type,
          plan_type: status.plan_type,
          resetDate: status.reset_date,
          reset_date: status.reset_date,
          billing_cycle: 'monthly',
          warning_threshold: status.warning_threshold,
          is_near_limit: status.is_near_limit,
          trial
        },
        credits_used: status.credits_used,
        credits_remaining: status.credits_remaining,
        total_limit: status.total_limit,
        plan_type: status.plan_type,
        reset_date: status.reset_date,
        ...(trial || {})
      }
    });
  });

  // GET /usage/users - per-user breakdown
  router.get('/users', async (req, res) => {
    const licenseKey = req.header('X-License-Key') || req.license?.license_key;
    const siteKey = req.header('X-Site-Key') || req.header('X-Site-Hash');
    if (!siteKey) return res.status(400).json({ error: 'INVALID_REQUEST', message: 'X-Site-Key or X-Site-Hash required' });

    const { periodStart, periodEnd } = getPeriodBounds(new Date().getUTCDate());
    const result = await getUserUsage(supabase, { licenseKey, siteHash: siteKey, periodStart, periodEnd });
    if (result.error) return res.status(500).json({ error: 'SERVER_ERROR', message: result.error.message });

    return res.json({
      site_id: siteKey,
      period_start: periodStart.toISOString(),
      period_end: periodEnd.toISOString(),
      total_credits_used: (result.users || []).reduce((s, u) => s + (u.credits_used || 0), 0),
      users: result.users || []
    });
  });

  // GET /usage/sites - per-site breakdown (agency)
  router.get('/sites', async (req, res) => {
    const licenseKey = req.header('X-License-Key') || req.license?.license_key;
    if (!licenseKey) return res.status(401).json({ error: 'INVALID_LICENSE', message: 'License key or JWT token required' });

    // Ensure plan is agency
    const { data: lic } = await supabase.from('licenses').select('plan').eq('license_key', licenseKey).single();
    if (!lic) return res.status(401).json({ error: 'INVALID_LICENSE', message: 'License not found' });
    if (lic.plan !== 'agency') {
      return res.status(403).json({
        error: 'PLAN_NOT_SUPPORTED',
        message: 'Multi-site usage tracking requires an Agency plan',
        code: 'PLAN_NOT_SUPPORTED'
      });
    }

    const { periodStart, periodEnd } = getPeriodBounds(new Date().getUTCDate());
    const result = await getSiteUsage(supabase, { licenseKey, periodStart, periodEnd });
    if (result.error) return res.status(500).json({ error: 'SERVER_ERROR', message: result.error.message });

    const totals = (result.sites || []).reduce(
      (acc, s) => {
        acc.total += s.credits_used || 0;
        return acc;
      },
      { total: 0 }
    );

    return res.json({
      license_id: licenseKey,
      plan_type: 'agency',
      total_credits_used: totals.total,
      total_limit: 10000,
      credits_remaining: Math.max(10000 - totals.total, 0),
      reset_date: periodEnd.toISOString(),
      sites: result.sites || []
    });
  });

  return router;
}

module.exports = { createUsageRouter };
