/**
 * Authoritative trial-generation metrics for the WordPress plugin / API clients.
 * All trial limit values must match services/anonymousTrial.getAnonymousTrialLimit() at runtime.
 */

function buildTrialGenerationForBatchPlan({
  requestedCount,
  trialLimit,
  trialUsedBefore,
  trialRemainingBefore
}) {
  const lim = Math.max(1, Number(trialLimit) || 0);
  const used = Math.max(0, Number(trialUsedBefore) || 0);
  const remaining = Math.max(0, Number(trialRemainingBefore) || 0);
  const req = Math.max(0, Math.floor(Number(requestedCount) || 0));
  const processableCount = Math.min(req, remaining);
  const skippedDueToLimit = Math.max(req - processableCount, 0);
  const usedAfterPlan = used + processableCount;

  return {
    contract_version: 1,
    requested_count: req,
    processable_count: processableCount,
    processed_count: 0,
    failed_count: 0,
    skipped_due_to_limit: skippedDueToLimit,
    skipped_other_reason: 0,
    trial_limit: lim,
    trial_used_before: used,
    trial_remaining_before: remaining,
    trial_used_after: null,
    trial_remaining_after: null,
    trial_exhausted_after: usedAfterPlan >= lim,
    limit_reached_during_run: false,
    scope: 'batch_plan'
  };
}

/**
 * Per-request snapshot for POST /api/alt-text (one image per request).
 */
function buildTrialGenerationForSingleRequest({
  outcome,
  batchRequestedTotal = null,
  trialLimit,
  trialUsedBefore,
  trialRemainingBefore,
  trialUsedAfter = null,
  trialRemainingAfter = null
}) {
  const lim = Math.max(1, Number(trialLimit) || 0);
  const usedBefore = Math.max(0, Number(trialUsedBefore) || 0);
  const remBefore = Math.max(0, Number(trialRemainingBefore) || 0);
  const usedAfter = trialUsedAfter != null ? Math.max(0, Number(trialUsedAfter) || 0) : null;
  const remAfter = trialRemainingAfter != null ? Math.max(0, Number(trialRemainingAfter) || 0) : null;

  let processedCount = 0;
  let failedCount = 0;
  let skippedDueToLimit = 0;
  let skippedOtherReason = 0;

  if (outcome === 'success') {
    processedCount = 1;
  } else if (outcome === 'quota_denied') {
    skippedDueToLimit = 1;
  } else if (outcome === 'generation_failed') {
    failedCount = 1;
  } else if (outcome === 'cached_hit') {
    skippedOtherReason = 0;
  }

  const batchReq = batchRequestedTotal != null
    ? Math.max(0, Math.floor(Number(batchRequestedTotal) || 0))
    : null;
  const batchProcessableEstimate = batchReq != null
    ? Math.min(batchReq, remBefore)
    : null;
  const batchSkippedDueToLimitEstimate = batchReq != null
    ? Math.max(batchReq - batchProcessableEstimate, 0)
    : null;

  const exhaustedAfter = usedAfter != null ? usedAfter >= lim : null;

  return {
    contract_version: 1,
    requested_count: 1,
    processable_count: outcome === 'success' ? 1 : outcome === 'quota_denied' ? 0 : outcome === 'cached_hit' ? 0 : 0,
    processed_count: processedCount,
    failed_count: failedCount,
    skipped_due_to_limit: skippedDueToLimit,
    skipped_other_reason: skippedOtherReason,
    trial_limit: lim,
    trial_used_before: usedBefore,
    trial_remaining_before: remBefore,
    trial_used_after: usedAfter,
    trial_remaining_after: remAfter,
    trial_exhausted_after: exhaustedAfter,
    limit_reached_during_run: Boolean(skippedDueToLimit) || exhaustedAfter === true,
    batch_requested_total: batchReq,
    batch_processable_at_request_start: batchProcessableEstimate,
    batch_skipped_due_to_limit_at_request_start: batchSkippedDueToLimitEstimate,
    scope: 'single_image_request'
  };
}

module.exports = {
  buildTrialGenerationForBatchPlan,
  buildTrialGenerationForSingleRequest
};
