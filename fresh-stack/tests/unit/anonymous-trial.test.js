const {
  buildAnonymousTrialStatus,
  getAnonymousQuotaState,
  getAnonymousTrialLimit
} = require('../../services/anonymousTrial');

describe('anonymous trial quota contract', () => {
  const originalEnv = {
    ANONYMOUS_TRIAL_CREDITS: process.env.ANONYMOUS_TRIAL_CREDITS,
    SITE_TRIAL_CREDITS: process.env.SITE_TRIAL_CREDITS,
    TRIAL_LIMIT: process.env.TRIAL_LIMIT
  };

  afterEach(() => {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test('defaults guest trial to 10 when trial env vars are unset', () => {
    delete process.env.ANONYMOUS_TRIAL_CREDITS;
    delete process.env.SITE_TRIAL_CREDITS;
    delete process.env.TRIAL_LIMIT;
    expect(getAnonymousTrialLimit()).toBe(10);
  });

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
      free_plan_offer: 25,
      anon_id: 'anon-contract-1'
    }));
  });

  test('marks the final remaining credit as near_limit', () => {
    expect(getAnonymousQuotaState({ used: 4, limit: 5 })).toBe('near_limit');
  });
});
