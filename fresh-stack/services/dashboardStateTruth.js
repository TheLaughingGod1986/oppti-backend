const logger = require('../lib/logger');
const { buildSiteIdentity } = require('../lib/siteIdentity');
const { getQuotaStatus } = require('./quota');
const { countImageAltStatesForSite } = require('./imageAltState');

const ACTIVE_QUEUE_JOB_STATUSES = new Set(['accepted', 'queued', 'preparing', 'generating', 'processing']);
const QUEUED_QUEUE_JOB_STATUSES = new Set(['accepted', 'queued']);
const PROCESSING_QUEUE_JOB_STATUSES = new Set(['preparing', 'generating', 'processing']);
const ACTIVE_GENERATION_REQUEST_STATUSES = new Set(['reserved']);
const TERMINAL_GENERATION_REQUEST_STATUSES = new Set(['succeeded', 'released', 'failed']);
const JOB_STALE_MS = Number(process.env.DASHBOARD_JOB_STALE_MS || 15 * 60 * 1000);
const GENERATION_REQUEST_STALE_MS = Number(process.env.DASHBOARD_GENERATION_REQUEST_STALE_MS || 10 * 60 * 1000);
const COUNT_AUDIT_LOOKBACK = Number(process.env.DASHBOARD_COUNT_AUDIT_LOOKBACK || 25);

function toIsoString(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function toSafeInteger(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, Math.trunc(parsed));
}

function firstInteger(...values) {
  for (const value of values) {
    const parsed = toSafeInteger(value);
    if (parsed !== null) return parsed;
  }
  return null;
}

function buildZeroCounts(source = 'none_available') {
  return {
    missing: 0,
    to_review: 0,
    optimized: 0,
    total_attention: 0,
    available: false,
    source
  };
}

function buildCountCandidates(metadata = {}) {
  if (!metadata || typeof metadata !== 'object') return [];
  return [
    metadata,
    metadata.counts,
    metadata.dashboard_counts,
    metadata.dashboard_state,
    metadata.summary,
    metadata.scan,
    metadata.state,
    metadata.snapshot
  ].filter((candidate) => candidate && typeof candidate === 'object');
}

function extractCountsFromPayload(payload = {}) {
  const missing = firstInteger(
    payload.missing,
    payload.missing_count,
    payload.missing_images,
    payload.images_missing,
    payload.missing_alt,
    payload.missingAlt
  );
  const toReview = firstInteger(
    payload.to_review,
    payload.to_review_count,
    payload.review_count,
    payload.needs_review,
    payload.needsReview,
    payload.review_ready
  );
  const optimized = firstInteger(
    payload.optimized,
    payload.optimized_count,
    payload.completed,
    payload.completed_count
  );
  const totalAttention = firstInteger(
    payload.total_attention,
    payload.attention_total,
    payload.totalAttention
  );

  if ([missing, toReview, optimized, totalAttention].every((value) => value === null)) {
    return null;
  }

  const normalizedMissing = missing ?? 0;
  const normalizedToReview = toReview ?? 0;
  const normalizedOptimized = optimized ?? 0;

  return {
    missing: normalizedMissing,
    to_review: normalizedToReview,
    optimized: normalizedOptimized,
    total_attention: totalAttention ?? (normalizedMissing + normalizedToReview)
  };
}

function extractCountsFromMetadata(metadata = {}) {
  for (const candidate of buildCountCandidates(metadata)) {
    const counts = extractCountsFromPayload(candidate);
    if (counts) return counts;
  }
  return null;
}

function summarizeQueueProgress(jobRecord = {}) {
  const items = Array.isArray(jobRecord.items) ? jobRecord.items : [];
  return {
    queueCount: items.filter((item) => item?.status === 'queued' || item?.stage === 'queued').length,
    progressDone: Number(jobRecord.completed || 0) + Number(jobRecord.failed || 0),
    progressTotal: Number(jobRecord.total || items.length || 0)
  };
}

function normalizeQueueJobStatus(rawStatus = '') {
  const normalized = String(rawStatus || '').toLowerCase();
  if (QUEUED_QUEUE_JOB_STATUSES.has(normalized)) return 'QUEUED';
  if (PROCESSING_QUEUE_JOB_STATUSES.has(normalized)) return 'PROCESSING';
  if (normalized === 'completed') return 'COMPLETED';
  if (normalized === 'failed') return 'FAILED';
  return 'IDLE';
}

function isStaleTimestamp(value, staleMs, now = Date.now()) {
  const timestamp = value ? new Date(value).getTime() : Number.NaN;
  if (!Number.isFinite(timestamp)) return false;
  return (now - timestamp) > staleMs;
}

function normalizeQueueJob(jobRecord, { requestedJobId = null } = {}) {
  const jobStatus = normalizeQueueJobStatus(jobRecord?.status);
  const lastUpdatedAt = toIsoString(
    jobRecord?.updatedAt
      || jobRecord?.batchProcessingStartedAt
      || jobRecord?.createdAt
      || jobRecord?.batchAcceptedAt
  );
  const stale = ACTIVE_QUEUE_JOB_STATUSES.has(String(jobRecord?.status || '').toLowerCase())
    && isStaleTimestamp(lastUpdatedAt, JOB_STALE_MS);
  const progress = summarizeQueueProgress(jobRecord);

  if (stale) {
    return {
      status: 'FAILED',
      active: false,
      pausable: false,
      progress_done: progress.progressDone,
      progress_total: progress.progressTotal,
      last_checked_at: new Date().toISOString(),
      queue_count: progress.queueCount,
      job_id: jobRecord?.jobId || requestedJobId || null,
      generation_request_id: null,
      stale: true,
      source: 'job_record_stale'
    };
  }

  return {
    status: jobStatus,
    active: jobStatus === 'QUEUED' || jobStatus === 'PROCESSING',
    pausable: false,
    progress_done: progress.progressDone,
    progress_total: progress.progressTotal,
    last_checked_at: new Date().toISOString(),
    queue_count: progress.queueCount,
    job_id: jobRecord?.jobId || requestedJobId || null,
    generation_request_id: null,
    stale: false,
    source: 'job_record'
  };
}

function normalizeGenerationRequestJob(record) {
  const status = String(record?.status || '').toLowerCase();
  const stale = ACTIVE_GENERATION_REQUEST_STATUSES.has(status)
    && isStaleTimestamp(record?.created_at, GENERATION_REQUEST_STALE_MS);

  if (stale) {
    return {
      status: 'FAILED',
      active: false,
      pausable: false,
      progress_done: 0,
      progress_total: 1,
      last_checked_at: new Date().toISOString(),
      queue_count: 0,
      job_id: null,
      generation_request_id: record?.id || null,
      stale: true,
      source: 'generation_requests_stale'
    };
  }

  if (status === 'reserved') {
    return {
      status: 'PROCESSING',
      active: true,
      pausable: false,
      progress_done: 0,
      progress_total: 1,
      last_checked_at: new Date().toISOString(),
      queue_count: 0,
      job_id: null,
      generation_request_id: record?.id || null,
      stale: false,
      source: 'generation_requests'
    };
  }

  if (status === 'failed') {
    return {
      status: 'FAILED',
      active: false,
      pausable: false,
      progress_done: 0,
      progress_total: 1,
      last_checked_at: new Date().toISOString(),
      queue_count: 0,
      job_id: null,
      generation_request_id: record?.id || null,
      stale: false,
      source: 'generation_requests'
    };
  }

  if (status === 'succeeded' || status === 'released') {
    return {
      status: 'COMPLETED',
      active: false,
      pausable: false,
      progress_done: 1,
      progress_total: 1,
      last_checked_at: new Date().toISOString(),
      queue_count: 0,
      job_id: null,
      generation_request_id: record?.id || null,
      stale: false,
      source: 'generation_requests'
    };
  }

  return null;
}

async function resolveCountsFromAuditLogs(supabase, siteId) {
  if (!supabase || !siteId) {
    return buildZeroCounts('none_available');
  }

  const { data, error } = await supabase
    .from('site_audit_logs')
    .select('event_type, metadata, created_at')
    .eq('site_id', siteId)
    .order('created_at', { ascending: false })
    .limit(COUNT_AUDIT_LOOKBACK);

  if (error) {
    logger.warn('[dashboard] count snapshot lookup failed', {
      site_id: siteId,
      error: error.message
    });
    return buildZeroCounts('site_audit_logs_unavailable');
  }

  const rows = Array.isArray(data) ? data : [];
  for (const row of rows) {
    const extracted = extractCountsFromMetadata(row?.metadata || {});
    if (extracted) {
      return {
        ...extracted,
        available: true,
        source: `site_audit_logs:${row.event_type || 'metadata'}`
      };
    }
  }

  return buildZeroCounts('site_audit_logs:none');
}

async function resolveCountsForSite(supabase, siteId) {
  const ledgerCounts = await countImageAltStatesForSite(supabase, siteId);

  if (ledgerCounts.available && Number(ledgerCounts.total_rows || 0) > 0) {
    const toReview = Number(ledgerCounts.generated || 0) + Number(ledgerCounts.needs_review || 0);
    const missing = Number(ledgerCounts.missing || 0);

    return {
      missing,
      to_review: toReview,
      optimized: Number(ledgerCounts.approved || 0),
      total_attention: missing + toReview,
      available: true,
      source: ledgerCounts.source
    };
  }

  if (ledgerCounts.available && Number(ledgerCounts.total_rows || 0) === 0) {
    logger.info('[dashboard] count_fallback_used', {
      site_id: siteId,
      reason: 'no_image_alt_state_rows'
    });
    return resolveCountsFromAuditLogs(supabase, siteId);
  }

  return buildZeroCounts(ledgerCounts.source || 'image_alt_states_error');
}

async function resolveJobFromGenerationRequests(supabase, siteId) {
  if (!supabase || !siteId) return null;

  const { data, error } = await supabase
    .from('generation_requests')
    .select('id, status, created_at, finalized_at')
    .eq('site_id', siteId)
    .order('created_at', { ascending: false })
    .limit(5);

  if (error) {
    logger.warn('[dashboard] generation request lookup failed', {
      site_id: siteId,
      error: error.message
    });
    return null;
  }

  const rows = Array.isArray(data) ? data : [];
  const activeRecord = rows.find((row) => ACTIVE_GENERATION_REQUEST_STATUSES.has(String(row?.status || '').toLowerCase()));
  if (activeRecord) {
    return normalizeGenerationRequestJob(activeRecord);
  }

  const terminalRecord = rows.find((row) => TERMINAL_GENERATION_REQUEST_STATUSES.has(String(row?.status || '').toLowerCase()));
  if (terminalRecord) {
    return normalizeGenerationRequestJob(terminalRecord);
  }

  return null;
}

function buildIdleJob(source = 'none') {
  return {
    status: 'IDLE',
    active: false,
    pausable: false,
    progress_done: 0,
    progress_total: 0,
    last_checked_at: new Date().toISOString(),
    queue_count: 0,
    job_id: null,
    generation_request_id: null,
    stale: false,
    source
  };
}

function buildCredits(status = {}) {
  const limit = Number(status.total_limit ?? 0);
  const used = Number(status.credits_used ?? 0);
  const remaining = Number(status.credits_remaining ?? Math.max(limit - used, 0));
  const source = status.plan_type === 'trial' ? 'trial' : 'license';

  return {
    limit,
    used,
    remaining,
    exhausted: remaining <= 0,
    source,
    resolution_source: 'getQuotaStatus'
  };
}

function isCountBackendFailure(counts = {}) {
  return counts?.source === 'image_alt_states_error';
}

function isExplicitGenerationFailure(job = {}) {
  return job?.status === 'FAILED' && job?.stale !== true;
}

function resolveDashboardState({ counts, job, credits } = {}) {
  const safeCounts = counts || buildZeroCounts();
  const safeJob = job || buildIdleJob();
  const safeCredits = credits || {};

  if (safeCredits.exhausted) {
    return { state: 'QUOTA_EXHAUSTED', source: 'credits.exhausted' };
  }

  if (isExplicitGenerationFailure(safeJob)) {
    return { state: 'ERROR', source: 'job.failed' };
  }

  if (safeJob.active && safeJob.status === 'QUEUED') {
    return { state: 'QUEUED', source: 'job.queued' };
  }

  if (safeJob.active && safeJob.status === 'PROCESSING') {
    return { state: 'PROCESSING', source: 'job.processing' };
  }

  if (isCountBackendFailure(safeCounts)) {
    return { state: 'ERROR', source: 'counts.error' };
  }

  if (!safeCounts.available) {
    return { state: 'MISSING_ALT', source: 'counts.unavailable_assumed_missing' };
  }

  if (Number(safeCounts.to_review) > 0) {
    return { state: 'NEEDS_REVIEW', source: 'counts.to_review' };
  }

  if (Number(safeCounts.missing) > 0) {
    return { state: 'MISSING_ALT', source: 'counts.missing' };
  }

  return { state: 'ALL_CLEAR', source: 'counts.clear' };
}

function buildDashboardSiteIdentity(req) {
  const hasAccountAuth = Boolean(req?.user || req?.license || req?.header?.('X-License-Key'));
  return buildSiteIdentity({
    siteHash: req?.trialMode
      ? req?.trialSiteHash
      : (req?.header?.('X-Site-Key') || req?.header?.('X-Site-Hash') || null),
    installUuid: req?.trialMode
      ? req?.trialSiteHash
      : (
        req?.header?.('X-Install-UUID')
        || req?.header?.('X-WP-Install-UUID')
        || req?.header?.('X-Site-Key')
        || req?.header?.('X-Site-Hash')
        || null
      ),
    siteUrl: req?.header?.('X-Site-URL') || null,
    siteFingerprint: req?.header?.('X-Site-Fingerprint') || null,
    allowDevelopment: Boolean(req?.trialMode || hasAccountAuth)
  });
}

async function resolveDashboardJob({
  supabase,
  site,
  requestedJobId = null,
  getJobRecord = null
} = {}) {
  if (requestedJobId && typeof getJobRecord === 'function') {
    const record = await getJobRecord(requestedJobId);
    if (record) {
      return normalizeQueueJob(record, { requestedJobId });
    }
  }

  const generationRequestJob = await resolveJobFromGenerationRequests(supabase, site?.id || null);
  if (generationRequestJob) {
    return generationRequestJob;
  }

  return buildIdleJob(requestedJobId ? 'job_record_missing' : 'none');
}

async function buildDashboardStateTruth({
  supabase,
  req,
  getJobRecord = null
} = {}) {
  const licenseKey = req?.header?.('X-License-Key') || req?.license?.license_key || null;
  const account = req?.user || req?.license || null;
  const siteIdentity = buildDashboardSiteIdentity(req);
  const requestedJobId = req?.query?.job_id
    || req?.query?.jobId
    || req?.header?.('X-Job-Id')
    || null;

  const quotaStatus = await getQuotaStatus(supabase, {
    account,
    licenseKey,
    siteHash: siteIdentity.siteHash || null,
    siteUrl: siteIdentity.siteUrl || null,
    siteFingerprint: siteIdentity.siteFingerprint || null,
    installUuid: siteIdentity.wpInstallUuid || null,
    requestId: req?.id || null,
    siteIdentity
  });

  if (quotaStatus?.error) {
    return {
      success: true,
      state: 'ERROR',
      counts: buildZeroCounts('quota_error'),
      job: buildIdleJob('quota_error'),
      credits: {
        limit: 0,
        used: 0,
        remaining: 0,
        exhausted: false,
        source: 'license'
      },
      site: {
        site_id: null,
        site_hash: siteIdentity.siteHash || null,
        linked: false
      },
      resolution: {
        state_source: 'quota.error',
        job_source: 'quota.error',
        credit_source: 'quota.error',
        count_source: 'quota.error'
      },
      error: {
        code: quotaStatus.error,
        message: quotaStatus.message || null
      }
    };
  }

  const site = quotaStatus?.site || null;
  const counts = await resolveCountsForSite(supabase, site?.id || null);
  const job = await resolveDashboardJob({
    supabase,
    site,
    requestedJobId,
    getJobRecord
  });
  const credits = buildCredits(quotaStatus);
  const resolvedState = resolveDashboardState({ counts, job, credits });

  const response = {
    success: true,
    state: resolvedState.state,
    counts: {
      missing: counts.missing,
      to_review: counts.to_review,
      optimized: counts.optimized,
      total_attention: counts.total_attention
    },
    job: {
      status: job.status,
      active: job.active,
      pausable: job.pausable,
      progress_done: job.progress_done,
      progress_total: job.progress_total,
      last_checked_at: job.last_checked_at,
      queue_count: job.queue_count,
      job_id: job.job_id,
      generation_request_id: job.generation_request_id
    },
    credits: {
      limit: credits.limit,
      used: credits.used,
      remaining: credits.remaining,
      exhausted: credits.exhausted,
      source: credits.source
    },
    site: {
      site_id: site?.id || null,
      site_hash: site?.site_hash || siteIdentity.siteHash || null,
      linked: Boolean(site?.id)
    },
    resolution: {
      state_source: resolvedState.source,
      job_source: job.source,
      credit_source: credits.resolution_source,
      count_source: counts.source
    }
  };

  logger.info('[dashboard] state_truth_resolved', {
    request_id: req?.id || null,
    state: response.state,
    job_status: response.job.status,
    counts: response.counts,
    credit_source: response.credits.source,
    job_source: response.resolution.job_source,
    site_linked: response.site.linked,
    site_id: response.site.site_id,
    site_hash: response.site.site_hash
  });

  return response;
}

module.exports = {
  buildDashboardSiteIdentity,
  buildDashboardStateTruth,
  buildIdleJob,
  buildZeroCounts,
  extractCountsFromMetadata,
  resolveDashboardState
};
