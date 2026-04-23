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
  sites = [],
  siteTrials = [],
  trialUsage = [],
  failTrialInit = false
} = {}) {
  const state = {
    licenses: [],
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
    siteSubscriptions: [],
    siteQuotas: [],
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
