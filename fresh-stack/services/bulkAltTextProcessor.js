const crypto = require('crypto');
const logger = require('../lib/logger');
const { validateImagePayload } = require('../lib/validation');
const { generateAltText } = require('../lib/openai');
const { buildSiteIdentity } = require('../lib/siteIdentity');
const { hashRequestFingerprint } = require('./siteQuota');
const {
  finalizeGenerationQuotaReservation,
  reserveGenerationQuota
} = require('./quota');
const { upsertGeneratedImageAltState } = require('./imageAltState');
const { recordUsage } = require('./usage');
const { resolveUsageAttributionUserId } = require('./usageAttribution');

function nowIso() {
  return new Date().toISOString();
}

function buildItemFingerprint({
  siteKey,
  userInfo,
  normalized,
  itemContext,
  itemId,
  jobId
}) {
  return hashRequestFingerprint({
    site_hash: siteKey || null,
    wp_install_uuid: siteKey || null,
    user_id: userInfo?.user_id || null,
    user_email: userInfo?.user_email || null,
    anon_id: null,
    filename: normalized.filename || null,
    url: normalized.url || null,
    image_hash: normalized.base64
      ? crypto.createHash('sha256').update(normalized.base64).digest('hex')
      : null,
    context: itemContext || {},
    regenerate: false,
    bulk_job_id: jobId,
    item_id: itemId
  });
}

/**
 * Run async tasks with a fixed concurrency limit (worker pool).
 */
async function runWithConcurrency(items, limit, worker) {
  if (!items.length) return [];
  const results = new Array(items.length);
  let next = 0;
  const cap = Math.max(1, Math.min(limit, items.length));

  async function runWorker() {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  }

  await Promise.all(Array.from({ length: cap }, () => runWorker()));
  return results;
}

function stripBulkMeta(context = {}) {
  const { _bulkLicenseKey, _bulkUserInfo, ...rest } = context;
  return rest;
}

function resolveQuotaPathLabel(reservation) {
  if (reservation?.reservation?.generation_request_id) {
    return 'V2 RPC';
  }
  if (reservation?.reservation?.quota_source === 'legacy_trial') {
    return 'legacy trial fallback';
  }
  if (reservation?.reservation?.quota_source === 'legacy') {
    return 'legacy license fallback';
  }
  return reservation?.reservation?.quota_source || 'unknown';
}

function logBulkGenerationTrace({
  reservation,
  effectiveSite,
  effectiveLicenseKey,
  userInfo,
  usageWrite,
  finalizeResult,
  jobId,
  itemIndex,
  finalResultState
}) {
  const payload = {
    endpoint: 'api/jobs/bulk',
    batch_job_id: jobId,
    item_index: itemIndex,
    final_result_state: finalResultState,
    user_id: userInfo?.user_id || null,
    user_email: userInfo?.user_email || null,
    license_key_prefix: effectiveLicenseKey ? `${effectiveLicenseKey.substring(0, 8)}...` : null,
    site_id: effectiveSite?.id || reservation?.site?.id || null,
    site_hash: effectiveSite?.site_hash || reservation?.site?.site_hash || null,
    quota_path: resolveQuotaPathLabel(reservation),
    quota_source: reservation?.reservation?.quota_source || null,
    generation_request_id: reservation?.reservation?.generation_request_id || null,
    generation_requests_used: Boolean(reservation?.reservation?.generation_request_id),
    usage_events_used: Boolean(reservation?.reservation?.generation_request_id),
    usage_logs_write_succeeded: usageWrite ? !usageWrite.error : null,
    usage_logs_write_error: usageWrite?.error ? usageWrite.error.message || String(usageWrite.error) : null,
    quota_summaries_should_have_updated: Boolean(usageWrite?.quota_summary_expected),
    generation_requests_final_status: finalizeResult?.data?.status || null,
    generation_finalize_error: finalizeResult?.error ? finalizeResult.error.message || String(finalizeResult.error) : null
  };
  const hasFailure = Boolean(
    payload.usage_logs_write_error
    || payload.generation_finalize_error
    || finalResultState !== 'succeeded'
  );
  logger[hasFailure ? 'warn' : 'info']('[usage] generation_accounting_trace', payload);
}

/**
 * One licensed (non-trial) alt-text generation for bulk jobs.
 */
async function processLicensedBulkItem({
  supabase,
  licenseKey,
  siteKey,
  userInfo,
  image,
  itemContext,
  jobId,
  itemIndex,
  clientItemId
}) {
  const siteIdentity = buildSiteIdentity({
    siteHash: siteKey,
    installUuid: siteKey,
    siteUrl: null,
    siteFingerprint: null,
    allowDevelopment: true
  });

  if (siteIdentity.error) {
    return {
      success: false,
      code: siteIdentity.error,
      message: 'Invalid site identity for bulk job'
    };
  }

  const { errors, warnings, normalized } = validateImagePayload(image);
  if (errors.length || !normalized) {
    return {
      success: false,
      code: 'INVALID_IMAGE',
      message: errors.join('; '),
      warnings
    };
  }

  const id = clientItemId != null ? String(clientItemId) : String(itemIndex);
  const idempotencyKey = `bulk:${jobId}:${id}`;
  const requestFingerprint = buildItemFingerprint({
    siteKey,
    userInfo,
    normalized,
    itemContext,
    itemId: id,
    jobId
  });

  const reservation = await reserveGenerationQuota(supabase, {
    account: null,
    licenseKey,
    siteIdentity,
    creditsNeeded: 1,
    quotaMode: 'site',
    idempotencyKey,
    requestFingerprint,
    requestMetadata: {
      endpoint: 'api/jobs',
      batch_job_id: jobId,
      item_index: itemIndex,
      item_client_id: clientItemId || null,
      wp_user_id: userInfo?.user_id || null
    },
    requestId: null
  });

  if (reservation.error) {
    logBulkGenerationTrace({
      reservation,
      effectiveSite: reservation.site || null,
      effectiveLicenseKey: licenseKey,
      userInfo,
      usageWrite: null,
      finalizeResult: null,
      jobId,
      itemIndex,
      finalResultState: 'quota_denied'
    });
    return {
      success: false,
      code: reservation.error,
      message: reservation.message || 'Quota denied',
      status: reservation.status || 402
    };
  }

  const effectiveSite = reservation.site || null;
  const effectiveLicenseKey = effectiveSite?.license_key || licenseKey || null;
  let licenseId = null;

  const genStart = Date.now();
  try {
    const generationResult = await generateAltText({
      image: normalized,
      context: { ...itemContext, filename: normalized.filename }
    });
    const generationTimeMs = Date.now() - genStart;

    const finalizeResult = await finalizeGenerationQuotaReservation(supabase, {
      generationRequestId: reservation.reservation?.generation_request_id || null,
      success: true,
      finalMetadata: {
        batch_job_id: jobId,
        item_index: itemIndex,
        model_used: generationResult.meta?.modelUsed || null,
        total_tokens: generationResult.usage?.total_tokens || null
      }
    });

    if (effectiveLicenseKey) {
      try {
        const { data: licenseData } = await supabase
          .from('licenses')
          .select('id')
          .eq('license_key', effectiveLicenseKey)
          .maybeSingle();
        licenseId = licenseData?.id || null;
      } catch (_e) {
        /* best-effort */
      }
    }

    const attribution = await resolveUsageAttributionUserId(supabase, {
      req: null,
      siteHash: effectiveSite?.site_hash || siteKey,
      effectiveSite,
      licenseId
    });

    const usageWrite = await recordUsage(supabase, {
      licenseKey: effectiveLicenseKey,
      licenseId,
      siteHash: effectiveSite?.site_hash || siteKey,
      userId: attribution.userId,
      userEmail: userInfo?.user_email,
      pluginVersion: userInfo?.plugin_version,
      creditsUsed: 1,
      promptTokens: generationResult.usage?.prompt_tokens,
      completionTokens: generationResult.usage?.completion_tokens,
      totalTokens: generationResult.usage?.total_tokens,
      cached: false,
      modelUsed: generationResult.meta?.modelUsed,
      generationTimeMs,
      imageUrl: normalized.url,
      imageFilename: normalized.filename,
      endpoint: 'api/jobs/bulk',
      status: 'success'
    });

    logger.debug('[usage] attribution_debug', {
      usage_log_id: usageWrite?.data?.id || null,
      site_hash_present: Boolean(effectiveSite?.site_hash || siteKey),
      license_id_present: Boolean(licenseId),
      user_id_source: attribution.source,
      endpoint: 'api/jobs/bulk',
      credits_used: 1
    });

    if (effectiveSite?.id) {
      await upsertGeneratedImageAltState(supabase, {
        siteId: effectiveSite.id,
        image: normalized,
        context: itemContext,
        altText: generationResult.altText,
        requestId: null,
        generationRequestId: reservation.reservation?.generation_request_id || null
      });
    } else {
      logger.warn('[image-state] ledger_write_skipped', {
        site_id: null,
        site_hash: effectiveSite?.site_hash || siteKey || null,
        batch_job_id: jobId,
        item_index: itemIndex,
        error: 'SITE_ID_UNAVAILABLE_AFTER_GENERATION'
      });
    }

    logBulkGenerationTrace({
      reservation,
      effectiveSite,
      effectiveLicenseKey,
      userInfo,
      usageWrite,
      finalizeResult,
      jobId,
      itemIndex,
      finalResultState: 'succeeded'
    });

    return {
      success: true,
      altText: generationResult.altText,
      usage: generationResult.usage,
      meta: generationResult.meta,
      warnings,
      providerDurationMs: generationTimeMs
    };
  } catch (error) {
    const finalizeResult = await finalizeGenerationQuotaReservation(supabase, {
      generationRequestId: reservation.reservation?.generation_request_id || null,
      success: false,
      finalMetadata: {
        error_message: error.message,
        error_code: error.code || 'GENERATION_FAILED',
        batch_job_id: jobId,
        item_index: itemIndex
      }
    });

    logBulkGenerationTrace({
      reservation,
      effectiveSite,
      effectiveLicenseKey,
      userInfo,
      usageWrite: null,
      finalizeResult,
      jobId,
      itemIndex,
      finalResultState: 'generation_failed'
    });

    return {
      success: false,
      code: error.code || 'GENERATION_FAILED',
      message: error.message || 'Generation failed',
      isRetryable: error.isRetryable === true
    };
  }
}

function createBulkAltTextProcessor({ supabase, getJobRecord, setJobRecord, itemConcurrency = 3 }) {
  function createPersistLock() {
    let chain = Promise.resolve();
    return function withLock(fn) {
      const next = chain.then(() => fn());
      chain = next.catch(() => {});
      return next;
    };
  }

  async function run(job) {
    const {
      jobId,
      items,
      context: rawContext,
      siteKey,
      licenseKey,
      userInfo
    } = job;

    if (!supabase || !licenseKey) {
      logger.error('[bulkAltText] missing supabase or licenseKey', { jobId });
      return;
    }

    const batchT0 = job.acceptedAtMs || Date.now();
    const sharedContext = stripBulkMeta(rawContext || {});
    const withLock = createPersistLock();

    let record = await getJobRecord(jobId);
    if (!record) {
      logger.error('[bulkAltText] job record missing', { jobId });
      return;
    }

    record.status = 'processing';
    record.batchProcessingStartedAt = nowIso();
    record.timings = {
      ...(record.timings || {}),
      batch_processing_started_ms: Date.now() - batchT0
    };
    await setJobRecord(jobId, record);

    async function applyOutcome(index, item, outcome, tPrep) {
      await withLock(async () => {
        const latest = await getJobRecord(jobId);
        if (!latest || !latest.items[index]) return;

        const doneAt = nowIso();
        const row = latest.items[index];
        const genMs = outcome.success ? (outcome.providerDurationMs || 0) : 0;

        if (outcome.success) {
          latest.completed += 1;
          Object.assign(row, {
            status: 'completed',
            stage: 'completed',
            altText: outcome.altText,
            success: true,
            usage: outcome.usage,
            meta: outcome.meta,
            timings: {
              ...row.timings,
              completed_at: doneAt,
              provider_duration_ms: outcome.providerDurationMs ?? genMs,
              total_item_ms: Date.now() - tPrep
            }
          });
          latest.results.push({
            id: item.id || `item-${index}`,
            altText: outcome.altText,
            success: true
          });
        } else {
          latest.failed += 1;
          Object.assign(row, {
            status: 'failed',
            stage: 'failed',
            success: false,
            error: outcome.message,
            errorCode: outcome.code,
            timings: {
              ...row.timings,
              completed_at: doneAt,
              total_item_ms: Date.now() - tPrep
            }
          });
          latest.results.push({
            id: item.id || `item-${index}`,
            altText: null,
            success: false,
            error: outcome.message,
            code: outcome.code
          });
        }

        if (index === 0) {
          latest.timings = {
            ...latest.timings,
            first_item_completed_ms: Date.now() - batchT0
          };
          if (outcome.success) {
            latest.timings.first_provider_response_ms = outcome.providerDurationMs ?? genMs;
          }
          latest.firstItemStartedAt = latest.firstItemStartedAt || nowIso();
        }

        await setJobRecord(jobId, latest);

        logger.info('[bulkAltText] item_finished', {
          job_id: jobId,
          item_index: index,
          success: outcome.success,
          code: outcome.code || null
        });
      });
    }

    async function processIndex(item, index) {
      const tPrep = Date.now();

      await withLock(async () => {
        const latest = await getJobRecord(jobId);
        if (!latest || !latest.items[index]) return;
        const row = latest.items[index];
        Object.assign(row, {
          status: 'preparing',
          stage: 'preparing',
          timings: { ...row.timings, preparing_started_at: nowIso() }
        });
        if (index === 0) {
          latest.timings.first_item_selected_ms = Date.now() - batchT0;
          latest.firstItemStartedAt = nowIso();
        }
        await setJobRecord(jobId, latest);
      });

      await withLock(async () => {
        const latest = await getJobRecord(jobId);
        if (!latest || !latest.items[index]) return;
        latest.items[index].status = 'generating';
        latest.items[index].stage = 'generating';
        latest.items[index].timings.generating_started_at = nowIso();
        latest.items[index].timings.prep_duration_ms = Date.now() - tPrep;
        await setJobRecord(jobId, latest);
      });

      const itemContext = { ...sharedContext, ...(item.context || {}) };
      const outcome = await processLicensedBulkItem({
        supabase,
        licenseKey,
        siteKey,
        userInfo: item.user || userInfo || {},
        image: item.image,
        itemContext,
        jobId,
        itemIndex: index,
        clientItemId: item.id
      });

      await applyOutcome(index, item, outcome, tPrep);
      return outcome;
    }

    try {
      if (items.length > 0) {
        await processIndex(items[0], 0);
      }

      const rest = items.slice(1);
      if (rest.length) {
        await runWithConcurrency(rest, itemConcurrency, (item, j) => processIndex(item, j + 1));
      }

      await withLock(async () => {
        const latest = await getJobRecord(jobId);
        if (!latest) return;
        latest.status = 'completed';
        latest.batchCompletedAt = nowIso();
        latest.timings = {
          ...latest.timings,
          batch_total_ms: Date.now() - batchT0
        };
        await setJobRecord(jobId, latest);
      });

      const final = await getJobRecord(jobId);
      logger.info('[bulkAltText] job_completed', {
        job_id: jobId,
        total: final?.total,
        completed: final?.completed,
        failed: final?.failed,
        batch_total_ms: final?.timings?.batch_total_ms
      });
    } catch (err) {
      logger.error('[bulkAltText] job_failed', {
        job_id: jobId,
        error: err.message,
        stack: err.stack
      });
      const latest = await getJobRecord(jobId);
      if (latest) {
        latest.status = 'failed';
        latest.batchError = err.message;
        latest.batchCompletedAt = nowIso();
        await setJobRecord(jobId, latest);
      }
    }
  }

  return { run };
}

module.exports = {
  createBulkAltTextProcessor,
  runWithConcurrency,
  processLicensedBulkItem
};
