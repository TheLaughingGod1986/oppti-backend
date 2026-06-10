const {
  buildAnonymousTrialStatus,
  getAnonymousQuotaState
} = require('../../services/anonymousTrial');

describe('anonymous trial quota contract', () => {
  test('builds the normalized anonymous quota contract', () => {
    const status = buildAnonymousTrialStatus({
      used: 3,
      limit: 5,
      anonId: 'anon-contract-1'
    });

    expect(status).toEqual(expect.objectContaining({
      auth_state: 'guest_trial',
      quota_type: 'trial',
      quota_state: 'active',
      credits_total: 5,
      credits_used: 3,
      credits_remaining: 2,
      signup_required: false,
      upgrade_required: false,
      free_plan_offer: 50,
      anon_id: 'anon-contract-1'
    }));
  });

  test('marks the final remaining credit as near_limit', () => {
    expect(getAnonymousQuotaState({ used: 4, limit: 5 })).toBe('near_limit');
  });
});
