const crypto = require('crypto');
const logger = require('./logger');

function nowIso() {
  return new Date().toISOString();
}

function normalizeItemIdentifier(item, index) {
  const attachmentId = item.attachment_id
    ?? item.attachmentId
    ?? item.image_id
    ?? item.imageId
    ?? null;

  const id = item.id ?? attachmentId ?? `item-${index}`;
  const idString = String(id);
  const attachmentIdString = attachmentId === null || attachmentId === undefined ? null : String(attachmentId);

  return {
    id: idString,
    attachment_id: attachmentIdString,
    attachmentId: attachmentIdString,
    image_id: attachmentIdString,
    imageId: attachmentIdString
  };
}

function buildBulkJobRecord(jobId, items, context, siteKey, acceptedAtMs) {
  return {
    jobId,
    type: 'bulk_alt_text',
    status: 'accepted',
    results: [],
    errors: [],
    total: items.length,
    completed: 0,
    failed: 0,
    siteKey,
    priority: context.priority || 'normal',
    createdAt: nowIso(),
    updatedAt: nowIso(),
    batchAcceptedAt: nowIso(),
    batchProcessingStartedAt: null,
    batchCompletedAt: null,
    firstItemStartedAt: null,
    progress: 0,
    items: items.map((item, i) => ({
      ...normalizeItemIdentifier(item, i),
      index: i,
      status: 'queued',
      stage: 'queued',
      altText: null,
      error: null,
      errorCode: null,
      success: null,
      timings: {}
    })),
    timings: {
      request_received_at: nowIso(),
      accepted_at_ms: acceptedAtMs
    }
  };
}

function createQueue({
  redis,
  jobHandler,
  concurrency = 2,
  ttlSeconds = 60 * 60 * 24 * 7,
  queueKey = 'alttext:queue',
  bulkDispatchMode = 'immediate',
  bulkRunner = null
}) {
  const jobStore = new Map();
  const jobQueue = [];
  let activeWorkers = 0;
  let redisWorkersStarted = false;

  async function setJobRecord(jobId, record) {
    record.updatedAt = nowIso();
    if (record.total > 0) {
      record.progress = Math.min(1, (record.completed + record.failed) / record.total);
    }
    if (redis) {
      await redis.set(`alttext:job:${jobId}`, JSON.stringify(record), 'EX', ttlSeconds);
    } else {
      jobStore.set(jobId, record);
    }
  }

  async function getJobRecord(jobId) {
    if (redis) {
      const val = await redis.get(`alttext:job:${jobId}`);
      return val ? JSON.parse(val) : null;
    }
    return jobStore.get(jobId) || null;
  }

  async function enqueueJob(job) {
    if (redis) {
      await redis.lpush(queueKey, JSON.stringify(job));
      startRedisWorkers();
    } else {
      jobQueue.push(job);
      processQueueInMemory();
    }
  }

  async function processQueueInMemory() {
    if (activeWorkers >= concurrency) return;
    const next = jobQueue.shift();
    if (!next) return;
    activeWorkers += 1;
    try {
      await jobHandler(next);
    } finally {
      activeWorkers -= 1;
      if (jobQueue.length) processQueueInMemory();
    }
  }

  function startRedisWorkers() {
    if (redisWorkersStarted || !redis) return;
    redisWorkersStarted = true;
    for (let i = 0; i < concurrency; i += 1) {
      redisWorkerLoop();
    }
  }

  async function redisWorkerLoop() {
    while (true) {
      try {
        const res = await redis.brpop(queueKey, 2);
        if (!res) continue;
        const [, payload] = res;
        const job = JSON.parse(payload);
        await jobHandler(job);
      } catch (err) {
        logger.error('[jobs] worker error', err.message);
        await new Promise(r => setTimeout(r, 300));
      }
    }
  }

  /**
   * Bulk alt-text job: persists record, then either runs immediately on this process
   * (default) or enqueues for a worker (redis / multi-instance).
   */
  async function createJob(items, context, siteKey, meta = {}) {
    const jobId = crypto.randomUUID();
    const acceptedAtMs = Date.now();
    const { licenseKey, userInfo } = meta;

    const jobRecord = buildBulkJobRecord(jobId, items, context, siteKey, acceptedAtMs);
    await setJobRecord(jobId, jobRecord);

    const job = {
      jobId,
      type: 'bulk_alt_text',
      items,
      context,
      siteKey,
      licenseKey: licenseKey || null,
      userInfo: userInfo || {},
      acceptedAtMs
    };

    const runBulk = async () => {
      if (!bulkRunner) {
        logger.error('[bulk] bulkRunner not configured', { jobId });
        return;
      }
      try {
        await bulkRunner(job);
      } catch (err) {
        logger.error('[bulk] bulkRunner threw', { jobId, error: err.message });
      }
    };

    if (bulkDispatchMode === 'redis' && redis) {
      await enqueueJob(job);
    } else {
      setImmediate(() => {
        runBulk();
      });
    }

    return jobId;
  }

  return {
    createJob,
    getJobRecord,
    setJobRecord,
    startRedisWorkers,
    enqueueJob
  };
}

module.exports = { createQueue, buildBulkJobRecord, normalizeItemIdentifier };
