const {
  buildTrialGenerationForBatchPlan,
  buildTrialGenerationForSingleRequest
} = require('../../lib/trialGenerationContract');

describe('trialGenerationContract', () => {
  test('buildTrialGenerationForBatchPlan caps processable by remaining', () => {
    const g = buildTrialGenerationForBatchPlan({
      requestedCount: 4,
      trialLimit: 5,
      trialUsedBefore: 2,
      trialRemainingBefore: 3
    });
    expect(g.requested_count).toBe(4);
    expect(g.processable_count).toBe(3);
    expect(g.skipped_due_to_limit).toBe(1);
    expect(g.trial_limit).toBe(5);
    expect(g.trial_used_before).toBe(2);
    expect(g.trial_remaining_before).toBe(3);
    expect(g.trial_exhausted_after).toBe(true);
  });

  test('buildTrialGenerationForSingleRequest success carries before/after', () => {
    const g = buildTrialGenerationForSingleRequest({
      outcome: 'success',
      batchRequestedTotal: 6,
      trialLimit: 5,
      trialUsedBefore: 2,
      trialRemainingBefore: 3,
      trialUsedAfter: 3,
      trialRemainingAfter: 2
    });
    expect(g.processed_count).toBe(1);
    expect(g.skipped_due_to_limit).toBe(0);
    expect(g.batch_requested_total).toBe(6);
    expect(g.batch_processable_at_request_start).toBe(3);
    expect(g.batch_skipped_due_to_limit_at_request_start).toBe(3);
  });

  test('buildTrialGenerationForSingleRequest quota_denied marks skip', () => {
    const g = buildTrialGenerationForSingleRequest({
      outcome: 'quota_denied',
      trialLimit: 5,
      trialUsedBefore: 5,
      trialRemainingBefore: 0,
      trialUsedAfter: 5,
      trialRemainingAfter: 0
    });
    expect(g.skipped_due_to_limit).toBe(1);
    expect(g.processable_count).toBe(0);
    expect(g.limit_reached_during_run).toBe(true);
  });
});
