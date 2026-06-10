const logger = require('../lib/logger');
const { buildSiteIdentity } = require('../lib/siteIdentity');
const { generateTitleAndMeta } = require('../lib/openaiTitles');
const { recordUsage } = require('./usage');
const { runWithConcurrency } = require('./bulkAltTextProcessor');
const {
  TITLES_FEATURE_TYPE,
  reserveTitleGenerationQuota,
  finalizeTitleGenerationQuota,
  buildTitleRequestFingerprint
} = require('./titleQuota');

// title (1) + meta (1), drawn from the shared wallet. Keep in sync with routes/titles.js.
const CREDITS_PER_PAGE = 2;

function nowIso() {
  return new Date().toISOString();
}

function stripBulkMeta(context = {}) {
  const { _bulkLicenseKey, _bulkUserInfo, ...rest } = context;
  return rest;
}

async function processLicensedBulkTitleItem({
  supabase,
  licenseKey,
  siteKey,
  userInfo,
  page,
  options,
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
      message: 'Invalid site identity for bulk titles job'
    };
  }

  if (!page || (typeof page !== 'object')) {
    return {
      success: false,
      code: 'INVALID_PAGE',
      message: 'Each bulk item must include a page object'
    };
  }

  const id = clientItemId != null ? String(clientItemId) : String(itemIndex);
  const idempotencyKey = `bulk:titles:${jobId}:${id}`;
  const requestFingerprint = buildTitleRequestFingerprint({
    siteKey,
    userInfo,
    page,
    options,
    previous: null,
    jobId,
    itemId: id
  });

  const reservation = await reserveTitleGenerationQuota(supabase, {
    account: null,
    licenseKey,
    siteIdentity,
    creditsNeeded: CREDITS_PER_PAGE,
    idempotencyKey,
    requestFingerprint,
    requestMetadata: {
      endpoint: 'api/titles/jobs',
      batch_job_id: jobId,
      item_index: itemIndex,
      item_client_id: clientItemId || null,
      page_url: page.url || null,
      credits_per_page: CREDITS_PER_PAGE,
      wp_user_id: userInfo?.user_id || null
    },
    requestId: null
  });

  if (reservation.error) {
    return {
      success: false,
      code: reservation.error,
      message: reservation.message || 'Quota denied',
      status: reservation.status || 402,
      payload: reservation.payload || null
    };
  }

  const effectiveSite = reservation.site || null;
  const effectiveLicenseKey = effectiveSite?.license_key || licenseKey || null;
  const generationRequestId = reservation.reservation?.generation_request_id || null;

  const genStart = Date.now();
  try {
    const result = await generateTitleAndMeta({ page, options, previous: null });
    const generationTimeMs = Date.now() - genStart;

    await finalizeTitleGenerationQuota(supabase, {
      generationRequestId,
      success: true,
      finalMetadata: {
        batch_job_id: jobId,
        item_index: itemIndex,
        model_used: result.meta_info?.modelUsed || null,
        total_tokens: result.usage?.total_tokens || null
      }
    });

    await recordUsage(supabase, {
      licenseKey: effectiveLicenseKey,
      siteHash: effectiveSite?.site_hash || siteKey,
      userEmail: userInfo?.user_email || null,
      pluginVersion: userInfo?.plugin_version,
      creditsUsed: CREDITS_PER_PAGE,
      promptTokens: result.usage?.prompt_tokens,
      completionTokens: result.usage?.completion_tokens,
      totalTokens: result.usage?.total_tokens,
      cached: false,
      modelUsed: result.meta_info?.modelUsed || null,
      generationTimeMs,
      endpoint: 'api/titles/jobs/bulk',
      status: 'success',
      featureType: TITLES_FEATURE_TYPE,
      generationBatchId: jobId
    });

    return {
      success: true,
      title: result.title,
      meta: result.meta,
      usage: result.usage,
      meta_info: result.meta_info,
      providerDurationMs: generationTimeMs
    };
  } catch (error) {
    await finalizeTitleGenerationQuota(supabase, {
      generationRequestId,
      success: false,
      finalMetadata: {
        error_message: error.message,
        error_code: error.code || 'GENERATION_FAILED',
        batch_job_id: jobId,
        item_index: itemIndex
      }
    });

    return {
      success: false,
      code: error.code || 'GENERATION_FAILED',
      message: error.message || 'Title generation failed',
      isRetryable: error.isRetryable === true
    };
  }
}

function createBulkTitlesProcessor({ supabase, getJobRecord, setJobRecord, itemConcurrency = 3 }) {
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
      logger.error('[bulkTitles] missing supabase or licenseKey', { jobId });
      return;
    }

    const batchT0 = job.acceptedAtMs || Date.now();
    const sharedContext = stripBulkMeta(rawContext || {});
    const sharedOptions = sharedContext.options || {};
    const withLock = createPersistLock();

    let record = await getJobRecord(jobId);
    if (!record) {
      logger.error('[bulkTitles] job record missing', { jobId });
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
            success: true,
            title: outcome.title,
            meta: outcome.meta,
            usage: outcome.usage,
            meta_info: outcome.meta_info,
            timings: {
              ...row.timings,
              completed_at: doneAt,
              provider_duration_ms: outcome.providerDurationMs ?? genMs,
              total_item_ms: Date.now() - tPrep
            }
          });
          latest.results.push({
            id: row.id,
            url: item.page?.url || null,
            title: outcome.title,
            meta: outcome.meta,
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
            id: row.id,
            url: item.page?.url || null,
            title: null,
            meta: null,
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

        logger.info('[bulkTitles] item_finished', {
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
          status: 'generating',
          stage: 'generating',
          timings: { ...row.timings, generating_started_at: nowIso(), prep_duration_ms: Date.now() - tPrep }
        });
        if (index === 0) {
          latest.timings.first_item_selected_ms = Date.now() - batchT0;
          latest.firstItemStartedAt = nowIso();
        }
        await setJobRecord(jobId, latest);
      });

      const itemOptions = { ...sharedOptions, ...(item.options || {}) };
      const outcome = await processLicensedBulkTitleItem({
        supabase,
        licenseKey,
        siteKey,
        userInfo: item.user || userInfo || {},
        page: item.page,
        options: itemOptions,
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
      logger.info('[bulkTitles] job_completed', {
        job_id: jobId,
        total: final?.total,
        completed: final?.completed,
        failed: final?.failed,
        batch_total_ms: final?.timings?.batch_total_ms
      });
    } catch (err) {
      logger.error('[bulkTitles] job_failed', {
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
  createBulkTitlesProcessor,
  processLicensedBulkTitleItem
};
