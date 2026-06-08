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

  test.each(['pro', 'growth'])('demotes stale %s state when the effective allowance is the free limit', (plan) => {
    const state = buildEntitlementState({
      plan_type: plan,
      total_limit: 50,
      credits_used: 0,
      credits_remaining: 50
    }, {
      isLoggedIn: true
    });

    expect(state.plan).toBe('free');
    expect(state.plan_type).toBe('free');
    expect(state.token_limit).toBe(50);
    expect(state.can_autopilot).toBe(false);
  });

  test('preserves real paid pro state at the paid monthly allowance', () => {
    const state = buildEntitlementState({
      plan_type: 'pro',
      total_limit: 1000,
      credits_used: 0,
      credits_remaining: 1000
    }, {
      isLoggedIn: true
    });

    expect(state.plan).toBe('pro');
    expect(state.plan_type).toBe('pro');
    expect(state.token_limit).toBe(1000);
    expect(state.can_autopilot).toBe(true);
  });
});
