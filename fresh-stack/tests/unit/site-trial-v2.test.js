jest.mock('../../lib/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  getRecentEntries: jest.fn().mockReturnValue([]),
  clearRecentEntries: jest.fn()
}));

const logger = require('../../lib/logger');
const { getAnonymousTrialStatus } = require('../../services/anonymousTrial');
const { getQuotaStatus, reserveGenerationQuota } = require('../../services/quota');

function createQuery(rows, { countMode = false, error = null } = {}) {
  const state = {
    rows: Array.isArray(rows) ? rows.slice() : [],
    countMode
  };

  const chain = {
    select(_columns, options = {}) {
      state.countMode = Boolean(options?.head && options?.count === 'exact');
      return chain;
    },
    eq(column, value) {
      state.rows = state.rows.filter((row) => row?.[column] === value);
      return chain;
    },
    in(column, values) {
      state.rows = state.rows.filter((row) => Array.isArray(values) && values.includes(row?.[column]));
      return chain;
    },
    gte(column, value) {
      state.rows = state.rows.filter((row) => row?.[column] >= value);
      return chain;
    },
    lt(column, value) {
      state.rows = state.rows.filter((row) => row?.[column] < value);
      return chain;
    },
    order(column, options = {}) {
      const ascending = options?.ascending !== false;
      state.rows = state.rows.slice().sort((left, right) => {
        const leftValue = left?.[column] ?? null;
        const rightValue = right?.[column] ?? null;
        if (leftValue === rightValue) return 0;
        if (leftValue === null) return 1;
        if (rightValue === null) return -1;
        return ascending
          ? (leftValue > rightValue ? 1 : -1)
          : (leftValue < rightValue ? 1 : -1);
      });
      return chain;
    },
    limit(count) {
      state.rows = state.rows.slice(0, count);
      return chain;
    },
    maybeSingle: jest.fn().mockImplementation(async () => ({
      data: error ? null : (state.rows[0] || null),
      error
    })),
    single: jest.fn().mockImplementation(async () => ({
      data: error ? null : (state.rows[0] || null),
      error
    })),
    then(resolve, reject) {
      const payload = state.countMode
        ? { count: error ? 0 : state.rows.length, error }
        : { data: error ? null : state.rows, error };
      return Promise.resolve(payload).then(resolve, reject);
    }
  };

  return chain;
}

function createV2TrialSupabaseMock({
  licenses = [],
  sites = [],
  siteSubscriptions = [],
  siteQuotas = [],
  siteTrials = [],
  trialUsage = [],
  failTrialInit = false
} = {}) {
  const state = {
    licenses: [...licenses],
    sites: [...sites],
    siteMemberships: [],
    siteAuditLogs: [],
    plans: [{
      id: 'free',
      display_name: 'Free',
      monthly_included_credits: 50,
      credit_grant_amount: 50,
      billing_interval_default: 'month',
      is_paid: false
    }],
    siteSubscriptions: [...siteSubscriptions],
    siteQuotas: [...siteQuotas],
    siteTrials: [...siteTrials],
    trialUsage: [...trialUsage],
    generationRequests: []
  };

  let siteCounter = state.sites.length + 1;
  let siteQuotaCounter = 1;
  let siteTrialCounter = state.siteTrials.length + 1;
  let generationCounter = 1;

  function insertReturning(row) {
    return {
      select() {
        return {
          single: jest.fn().mockResolvedValue({ data: row, error: null })
        };
      }
    };
  }

  return {
    _state: state,
    from(table) {
      if (table === 'licenses') {
        return { select: () => createQuery(state.licenses) };
      }

      if (table === 'sites') {
        return {
          select: () => createQuery(state.sites),
          insert(payload) {
            const row = {
              id: `site_${siteCounter++}`,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
              ...payload
            };
            state.sites.push(row);
            return insertReturning(row);
          },
          update(payload) {
            return {
              eq(column, value) {
                const row = state.sites.find((site) => site[column] === value);
                if (row) Object.assign(row, payload);
                return insertReturning(row || null);
              }
            };
          }
        };
      }

      if (table === 'site_memberships') {
        return {
          select: () => createQuery(state.siteMemberships),
          insert(payload) {
            const row = { id: `membership_${state.siteMemberships.length + 1}`, ...payload };
            state.siteMemberships.push(row);
            return insertReturning(row);
          },
          update(payload) {
            return {
              eq(column, value) {
                const row = state.siteMemberships.find((membership) => membership[column] === value);
                if (row) Object.assign(row, payload);
                return insertReturning(row || null);
              }
            };
          }
        };
      }

      if (table === 'site_audit_logs') {
        return {
          insert(payload) {
            state.siteAuditLogs.push(payload);
            return Promise.resolve({ data: payload, error: null });
          }
        };
      }

      if (table === 'plans') {
        return { select: () => createQuery(state.plans) };
      }

      if (table === 'site_subscriptions') {
        return { select: () => createQuery(state.siteSubscriptions) };
      }

      if (table === 'site_quotas') {
        return {
          select: () => createQuery(state.siteQuotas),
          insert(payload) {
            const row = { id: `site_quota_${siteQuotaCounter++}`, ...payload };
            state.siteQuotas.push(row);
            return insertReturning(row);
          }
        };
      }

      if (table === 'site_trials') {
        return {
          select: () => createQuery(state.siteTrials),
          insert(payload) {
            if (failTrialInit) {
              return {
                select() {
                  return {
                    single: jest.fn().mockResolvedValue({
                      data: null,
                      error: {
                        code: '23514',
                        message: 'site trial insert blocked'
                      }
                    })
                  };
                }
              };
            }

            const row = {
              id: `site_trial_${siteTrialCounter++}`,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
              ...payload
            };
            state.siteTrials.push(row);
            return insertReturning(row);
          }
        };
      }

      if (table === 'trial_usage') {
        return {
          select(_columns, options = {}) {
            return createQuery(state.trialUsage, {
              countMode: Boolean(options?.head && options?.count === 'exact')
            });
          }
        };
      }

      if (table === 'usage_logs' || table === 'quota_summaries') {
        return { select: () => createQuery([]) };
      }

      throw new Error(`Unexpected table: ${table}`);
    },
    async rpc(name, payload) {
      if (name !== 'bbai_reserve_site_generation') {
        return { data: null, error: { code: '42883', message: 'unknown function' } };
      }

      if (payload.p_quota_mode !== 'trial') {
        return {
          data: {
            ok: true,
            quota_source: 'site_quota',
            generation_request_id: `generation_request_${generationCounter++}`
          },
          error: null
        };
      }

      let trial = state.siteTrials
        .filter((row) => row.site_id === payload.p_site_id && row.trial_type === 'initial')
        .sort((left, right) => {
          const statusDelta = (left.status === 'active' ? 0 : 1) - (right.status === 'active' ? 0 : 1);
          if (statusDelta !== 0) return statusDelta;
          return String(right.created_at || '').localeCompare(String(left.created_at || ''));
        })[0];

      if (!trial) {
        trial = {
          id: `site_trial_${siteTrialCounter++}`,
          site_id: payload.p_site_id,
          trial_type: 'initial',
          total_trial_credits: payload.p_trial_credits || 5,
          used_trial_credits: 0,
          status: 'active',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        };
        state.siteTrials.push(trial);
      }

      const creditsNeeded = Number(payload.p_credits || 1);
      trial.used_trial_credits += creditsNeeded;
      if (trial.used_trial_credits >= trial.total_trial_credits) {
        trial.status = 'exhausted';
      }

      const generationRequest = {
        id: `generation_request_${generationCounter++}`,
        site_id: payload.p_site_id,
        site_trial_id: trial.id,
        quota_source: 'trial'
      };
      state.generationRequests.push(generationRequest);

      return {
        data: {
          ok: true,
          status: 'reserved',
          quota_source: 'trial',
          generation_request_id: generationRequest.id,
          remaining_credits: Math.max(trial.total_trial_credits - trial.used_trial_credits, 0),
          total_limit: trial.total_trial_credits,
          credits_used: trial.used_trial_credits,
          plan: 'trial'
        },
        error: null
      };
    }
  };
}

describe('V2 anonymous site trials', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.ANONYMOUS_TRIAL_CREDITS = '5';
  });

  test('paid license resolves by canonical domain when site hash changes', async () => {
    const periodStart = '2026-06-01T00:00:00.000Z';
    const periodEnd = '2026-07-01T00:00:00.000Z';
    const supabase = createV2TrialSupabaseMock({
      licenses: [{
        id: '68d299e9-44d0-4e54-90aa-c6a4053a47cf',
        email: 'nellamarievtonder@gmail.com',
        license_key: 'eb1f132a-5bfa-446f-8f72-057b90791260',
        plan: 'pro',
        status: 'active',
        billing_cycle: 'monthly'
      }],
      sites: [{
        id: '7b4d51fc-4cbb-4618-b1e6-227da13cb1c8',
        license_key: 'eb1f132a-5bfa-446f-8f72-057b90791260',
        site_hash: '7d7f750946e8c3e0f0228e1d737bb26c',
        wp_install_uuid: '7d7f750946e8c3e0f0228e1d737bb26c',
        site_url: 'https://edprevent.com',
        normalized_site_url: 'https://edprevent.com',
        canonical_domain: 'edprevent.com',
        site_fingerprint: 'fingerprint-paid',
        status: 'active',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }],
      siteSubscriptions: [{
        id: 'site_sub_paid',
        site_id: '7b4d51fc-4cbb-4618-b1e6-227da13cb1c8',
        plan_id: 'pro',
        stripe_customer_id: 'cus_Ud914UHz3btRTe',
        stripe_subscription_id: 'sub_1TdsjCJI9Rm418cMw7IcorZg',
        status: 'active',
        billing_interval: 'month',
        current_period_start: periodStart,
        current_period_end: periodEnd
      }],
      siteQuotas: [{
        id: 'site_quota_paid',
        site_id: '7b4d51fc-4cbb-4618-b1e6-227da13cb1c8',
        quota_period_start: periodStart,
        quota_period_end: periodEnd,
        monthly_included_credits: 1000,
        purchased_credits_balance: 0,
        bonus_credits_balance: 0,
        used_credits: 46,
        remaining_credits: 954
      }]
    });

    const status = await getQuotaStatus(supabase, {
      licenseKey: 'eb1f132a-5bfa-446f-8f72-057b90791260',
      account: {
        id: '68d299e9-44d0-4e54-90aa-c6a4053a47cf',
        license_key: 'eb1f132a-5bfa-446f-8f72-057b90791260',
        plan: 'pro',
        status: 'active'
      },
      siteHash: '4134bd05c315081e3de298c31cff8ae0',
      installUuid: '4134bd05c315081e3de298c31cff8ae0',
      siteUrl: 'https://edprevent.com',
      siteFingerprint: 'fingerprint-request',
      quotaMode: 'site',
      requestId: 'req-paid-domain-fallback'
    });

    expect(status.error).toBeNull();
    expect(status.site.id).toBe('7b4d51fc-4cbb-4618-b1e6-227da13cb1c8');
    expect(status.plan_type).toBe('pro');
    expect(status.total_limit).toBe(1000);
    expect(status.credits_remaining).toBe(954);
    expect(status.subscription).toEqual(expect.objectContaining({
      stripe_subscription_id: 'sub_1TdsjCJI9Rm418cMw7IcorZg'
    }));
    expect(logger.info).toHaveBeenCalledWith(
      '[siteQuota] Existing site reused',
      expect.objectContaining({
        site_id: '7b4d51fc-4cbb-4618-b1e6-227da13cb1c8',
        matched_by: 'canonical_domain+license_key'
      })
    );
  });

  test('trial reservation initializes site_trials and reuses the row', async () => {
    const supabase = createV2TrialSupabaseMock();
    const request = {
      siteHash: 'trial-v2-site',
      siteUrl: 'https://example.com',
      installUuid: 'trial-v2-site',
      quotaMode: 'trial'
    };

    const first = await reserveGenerationQuota(supabase, {
      ...request,
      requestId: 'req-trial-v2-1'
    });
    const second = await reserveGenerationQuota(supabase, {
      ...request,
      requestId: 'req-trial-v2-2'
    });

    expect(first.error).toBeNull();
    expect(second.error).toBeNull();
    expect(first.reservation.quota_source).toBe('trial');
    expect(second.reservation.quota_source).toBe('trial');
    expect(supabase._state.siteTrials).toHaveLength(1);
    expect(supabase._state.siteTrials[0]).toEqual(expect.objectContaining({
      site_id: 'site_1',
      trial_type: 'initial',
      total_trial_credits: 5,
      used_trial_credits: 2
    }));
    expect(logger.info).toHaveBeenCalledWith(
      '[siteQuota] site trial initialized',
      expect.objectContaining({ site_id: 'site_1' })
    );
    expect(logger.warn).not.toHaveBeenCalledWith(
      expect.stringContaining('[V2_FALLBACK]'),
      expect.anything()
    );
  });

  test('trial status reads resolve from initialized site_trials', async () => {
    const supabase = createV2TrialSupabaseMock({
      sites: [{
        id: 'site_existing',
        site_hash: 'trial-status-site',
        wp_install_uuid: 'trial-status-site',
        site_url: 'https://example.com',
        normalized_site_url: 'example.com',
        canonical_domain: 'example.com',
        status: 'active',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }],
      siteTrials: [{
        id: 'trial_existing',
        site_id: 'site_existing',
        trial_type: 'initial',
        total_trial_credits: 5,
        used_trial_credits: 3,
        status: 'active',
        created_at: new Date().toISOString()
      }]
    });

    const status = await getQuotaStatus(supabase, {
      siteHash: 'trial-status-site',
      siteUrl: 'https://example.com',
      installUuid: 'trial-status-site',
      quotaMode: 'trial',
      requestId: 'req-trial-status'
    });
    const trial = await getAnonymousTrialStatus(supabase, {
      quotaStatus: status,
      siteHash: 'trial-status-site',
      anonId: 'anon-status'
    });

    expect(status.error).toBeNull();
    expect(status.trial).toEqual(expect.objectContaining({
      total_trial_credits: 5,
      used_trial_credits: 3,
      remaining_trial_credits: 2
    }));
    expect(trial).toEqual(expect.objectContaining({
      credits_total: 5,
      credits_used: 3,
      credits_remaining: 2,
      anon_id: 'anon-status'
    }));
    expect(supabase._state.siteTrials).toHaveLength(1);
    expect(logger.info).toHaveBeenCalledWith(
      '[anonymousTrial] quota resolved',
      expect.objectContaining({ source: 'site_trials' })
    );
  });

  test('trial init failure falls back to legacy trial_usage with explicit logs', async () => {
    const supabase = createV2TrialSupabaseMock({
      failTrialInit: true,
      trialUsage: [
        { id: 'trial_usage_1', site_hash: 'trial-init-fail' },
        { id: 'trial_usage_2', site_hash: 'trial-init-fail' }
      ]
    });

    const reservation = await reserveGenerationQuota(supabase, {
      siteHash: 'trial-init-fail',
      siteUrl: 'https://example.com',
      installUuid: 'trial-init-fail',
      quotaMode: 'trial',
      requestId: 'req-trial-init-fail'
    });
    const legacyStatus = await getAnonymousTrialStatus(supabase, {
      quotaStatus: {},
      siteHash: 'trial-init-fail',
      anonId: 'anon-fallback'
    });

    expect(reservation.error).toBeNull();
    expect(reservation.reservation).toEqual(expect.objectContaining({
      status: 'legacy_trial',
      quota_source: 'legacy_trial',
      plan: 'trial'
    }));
    expect(legacyStatus).toEqual(expect.objectContaining({
      credits_used: 2,
      credits_remaining: 3,
      anon_id: 'anon-fallback'
    }));
    expect(supabase._state.siteTrials).toHaveLength(0);
    expect(logger.error).toHaveBeenCalledWith(
      '[siteQuota] site trial init failed',
      expect.objectContaining({
        error_code: 'SITE_TRIAL_INIT_FAILED',
        site_id: 'site_1'
      })
    );
    expect(logger.warn).toHaveBeenCalledWith(
      '[V2_FALLBACK] Trial reservation V2 path failed; using legacy trial fallback',
      expect.objectContaining({
        v2_error_code: 'SITE_TRIAL_INIT_FAILED',
        site_hash: 'trial-init-fail'
      })
    );
    expect(logger.info).toHaveBeenCalledWith(
      '[anonymousTrial] quota resolved',
      expect.objectContaining({ source: 'trial_usage' })
    );
  });
});
