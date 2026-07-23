const express = require('express');
const { z } = require('zod');
const logger = require('../lib/logger');
const { buildAnonymousContext } = require('../lib/anonymousIdentity');
const { buildTrialGenerationForBatchPlan } = require('../lib/trialGenerationContract');
const {
  buildAnonymousTrialStatus,
  getAnonymousTrialLimit,
  getAnonymousTrialStatus
} = require('../services/anonymousTrial');
const { getQuotaStatus } = require('../services/quota');
const { getUserUsage, getSiteUsage, getPeriodBounds } = require('../services/usage');
const { buildEntitlementState } = require('../services/entitlementState');

function inferQuotaType(planType = 'free') {
  if (planType === 'free') return 'monthly';
  if (planType === 'credits') return 'credits';
  return 'paid';
}

function resolveQuotaState(status = {}) {
  if (Number(status.credits_remaining) <= 0) {
    return 'exhausted';
  }

  if (status.is_near_limit) {
    return 'near_limit';
  }

  return 'active';
}

const trialBatchPlanSchema = z.object({
  requested_count: z.number().int().positive().max(500)
});

function createUsageRouter({ supabase }) {
  const router = express.Router();

  /**
   * POST /usage/trial-batch-plan
   * Authoritative batch sizing for anonymous trial bulk generation (call once before the loop).
   */
  router.post('/trial-batch-plan', async (req, res) => {
    if (!req.trialMode) {
      return res.status(403).json({
        success: false,
        error: 'TRIAL_ONLY',
        message: 'trial-batch-plan requires anonymous trial headers'
      });
    }

    const parsed = trialBatchPlanSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        error: 'INVALID_REQUEST',
        details: parsed.error.flatten()
      });
    }

    const siteKey = req.trialSiteHash;
    const siteFingerprint = req.header('X-Site-Fingerprint') || null;
    const siteUrl = req.header('X-Site-URL') || null;
    const anonymousContext = buildAnonymousContext({
      req,
      siteIdentity: {
        siteHash: siteKey,
        siteFingerprint
      }
    });

    const status = await getQuotaStatus(supabase, {
      account: req.user || req.license || null,
      licenseKey: req.header('X-License-Key') || req.license?.license_key,
      siteHash: siteKey,
      siteUrl,
      siteFingerprint,
      installUuid: siteKey,
      quotaMode: 'trial',
      requestId: req.id || null
    });

    const trial =
      (await getAnonymousTrialStatus(supabase, {
        quotaStatus: status.error ? {} : status,
        siteHash: siteKey,
        anonId: anonymousContext.anonId
      }))
      || buildAnonymousTrialStatus({
        used: 0,
        limit: getAnonymousTrialLimit(),
        anonId: anonymousContext.anonId
      });

    const trialGeneration = buildTrialGenerationForBatchPlan({
      requestedCount: parsed.data.requested_count,
      trialLimit: trial.trial_limit,
      trialUsedBefore: trial.trial_used,
      trialRemainingBefore: trial.trial_remaining
    });

    logger.info('[usage] trial_batch_plan', {
      site_hash: siteKey,
      anon_id: anonymousContext.anonId || null,
      requested_count: trialGeneration.requested_count,
      processable_count: trialGeneration.processable_count,
      skipped_due_to_limit: trialGeneration.skipped_due_to_limit,
      trial_used_before: trialGeneration.trial_used_before,
      trial_limit: trialGeneration.trial_limit
    });

    return res.json({
      success: true,
      trial_generation: trialGeneration,
      trial_limit: trial.trial_limit,
      trial_used: trial.trial_used,
      trial_remaining: trial.trial_remaining,
      trial_exhausted: trial.trial_exhausted,
      anon_id: trial.anon_id || anonymousContext.anonId || null
    });
  });

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
    const anonymousContext = buildAnonymousContext({
      req,
      siteIdentity: {
        siteHash: siteKey,
        siteFingerprint
      }
    });

    const status = await getQuotaStatus(supabase, {
      account: req.user || req.license || null,
      licenseKey,
      siteHash: siteKey,
      siteUrl,
      siteFingerprint,
      installUuid: siteKey,
      quotaMode: req.trialMode ? 'trial' : 'site',
      requestId: req.id || null
    });

    // For trial mode, quota status may fail (no license) — that's expected.
    // Build trial status directly from trial_usage table as authoritative source.
    if (req.trialMode) {
      const trial = await getAnonymousTrialStatus(supabase, {
        quotaStatus: status.error ? {} : status,
        siteHash: siteKey,
        anonId: anonymousContext.anonId
      });

      const trialInfo = trial || buildAnonymousTrialStatus({
        used: 0,
        limit: getAnonymousTrialLimit(),
        anonId: anonymousContext.anonId
      });

      logger.info('[usage] Anonymous identity resolved', {
        site_hash: siteKey,
        anon_id: anonymousContext.anonId || null,
        anon_id_source: anonymousContext.source || null,
        risk_key: anonymousContext.riskKey || null,
        site_url: siteUrl,
        site_fingerprint: siteFingerprint ? 'present' : 'absent'
      });
      logger.info('[usage] Anonymous quota check', {
        site_hash: siteKey,
        anon_id: trialInfo.anon_id || null,
        credits_used: trialInfo.credits_used,
        credits_total: trialInfo.credits_total,
        credits_remaining: trialInfo.credits_remaining,
        quota_state: trialInfo.quota_state,
        quota_source: status?.trial ? 'site_trials' : 'trial_usage'
      });
      logger.info('[usage] Anonymous signup_required state returned', {
        site_hash: siteKey,
        anon_id: trialInfo.anon_id || null,
        signup_required: trialInfo.signup_required,
        quota_state: trialInfo.quota_state,
        free_plan_offer: trialInfo.free_plan_offer
      });

      return res.json({
        success: true,
        data: {
          entitlement_state: buildEntitlementState(trialInfo, {
            isLoggedIn: false,
            isTrial: true
          }),
          usage: {
            used: trialInfo.credits_used,
            remaining: trialInfo.credits_remaining,
            limit: trialInfo.credits_total,
            plan: 'trial',
            plan_type: 'trial',
            billing_cycle: 'trial',
            auth_state: trialInfo.auth_state,
            quota_type: trialInfo.quota_type,
            quota_state: trialInfo.quota_state,
            signup_required: trialInfo.signup_required,
            upgrade_required: trialInfo.upgrade_required,
            free_plan_offer: trialInfo.free_plan_offer,
            trial: trialInfo
          },
          trial_generation_contract_version: 1,
          trial_authoritative: {
            trial_limit: trialInfo.trial_limit,
            trial_used: trialInfo.trial_used,
            trial_remaining: trialInfo.trial_remaining,
            trial_exhausted: trialInfo.trial_exhausted,
            scope: 'dashboard_bootstrap'
          },
          ...trialInfo
        }
      });
    }

    if (status.error) {
      return res.status(status.status || 401).json(status);
    }

    const entitlementState = buildEntitlementState(status, {
      isLoggedIn: true,
      isTrial: false
    });
    const responsePlanType = entitlementState.plan_type || entitlementState.plan || status.plan_type || 'free';
    const quotaState = status.quota_state || resolveQuotaState(status);
    const quotaType = inferQuotaType(responsePlanType);

    // Return in format expected by plugin
    return res.json({
      success: true,
      data: {
        entitlement_state: entitlementState,
        usage: {
          used: status.credits_used,
          remaining: status.credits_remaining,
          limit: status.total_limit,
          plan: responsePlanType,
          plan_type: responsePlanType,
          resetDate: status.reset_date,
          reset_date: status.reset_date,
          billing_cycle: 'monthly',
          auth_state: 'authenticated',
          quota_type: quotaType,
          quota_state: quotaState,
          signup_required: false,
          upgrade_required: false,
          free_plan_offer: 15,
          warning_threshold: status.warning_threshold,
          is_near_limit: status.is_near_limit
        },
        auth_state: 'authenticated',
        quota_type: quotaType,
        quota_state: quotaState,
        credits_total: status.total_limit,
        credits_used: status.credits_used,
        credits_remaining: status.credits_remaining,
        total_limit: status.total_limit,
        plan_type: status.plan_type,
        reset_date: status.reset_date,
        signup_required: false,
        upgrade_required: false,
        free_plan_offer: 15
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
