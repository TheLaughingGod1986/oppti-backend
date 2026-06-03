const { buildEntitlementState } = require('../../services/entitlementState');

describe('buildEntitlementState', () => {
  test.each([
    [0, 50, true, 50],
    [49, 50, true, 1],
    [50, 50, false, 0],
    [51, 50, false, 0]
  ])('free plan usage %i/%i sets can_generate=%s and remaining=%i', (used, limit, canGenerate, remaining) => {
    const state = buildEntitlementState({
      plan_type: 'free',
      credits_used: used,
      total_limit: limit
    }, {
      isLoggedIn: true
    });

    expect(state.tokens_remaining).toBe(remaining);
    expect(state.can_generate).toBe(canGenerate);
    expect(state.can_autopilot).toBe(false);
  });

  test('blocks only free generation after five daily successes while monthly credits remain', () => {
    const state = buildEntitlementState({
      plan_type: 'free',
      credits_used: 5,
      credits_remaining: 45,
      total_limit: 50,
      daily_generation_limit: 5,
      daily_generations_used: 5,
      daily_generations_remaining: 0,
      daily_reset_date: '2026-05-27T00:00:00.000Z'
    }, {
      isLoggedIn: true
    });

    expect(state.tokens_remaining).toBe(45);
    expect(state.can_generate).toBe(false);
    expect(state.quota_state).toBe('daily_exhausted');
    expect(state.message).toBe('Daily generation allowance exhausted.');
  });

  test('recognizes an unlimited entitlement instead of blocking it', () => {
    const state = buildEntitlementState({
      plan_type: 'unlimited',
      total_limit: -1,
      credits_used: 9000,
      credits_remaining: 0
    });

    expect(state.is_unlimited).toBe(true);
    expect(state.token_limit).toBeNull();
    expect(state.tokens_remaining).toBeNull();
    expect(state.can_generate).toBe(true);
  });

  test('handles a null limit conservatively unless remaining credits are explicitly supplied', () => {
    const unknown = buildEntitlementState({
      plan_type: 'pro',
      total_limit: null,
      credits_used: 1
    });
    const reportedBalance = buildEntitlementState({
      plan_type: 'pro',
      total_limit: null,
      credits_used: 1,
      credits_remaining: 10
    });

    expect(unknown.token_limit).toBeNull();
    expect(unknown.can_generate).toBe(false);
    expect(reportedBalance.can_generate).toBe(true);
  });
});
