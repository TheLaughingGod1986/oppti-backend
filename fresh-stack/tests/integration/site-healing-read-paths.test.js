jest.mock('../../lib/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn()
}));

const { getQuotaStatus } = require('../../services/quota');
const { buildDashboardStateTruth } = require('../../services/dashboardStateTruth');
const { resolveImageAltStateSiteContext } = require('../../services/imageAltState');
const logger = require('../../lib/logger');

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
      const threshold = Date.parse(value);
      state.rows = state.rows.filter((row) => {
        const rowValue = row?.[column];
        const rowTimestamp = Date.parse(rowValue);
        if (!Number.isNaN(threshold) && !Number.isNaN(rowTimestamp)) {
          return rowTimestamp >= threshold;
        }
        return rowValue >= value;
      });
      return chain;
    },
    lt(column, value) {
      const threshold = Date.parse(value);
      state.rows = state.rows.filter((row) => {
        const rowValue = row?.[column];
        const rowTimestamp = Date.parse(rowValue);
        if (!Number.isNaN(threshold) && !Number.isNaN(rowTimestamp)) {
          return rowTimestamp < threshold;
        }
        return rowValue < value;
      });
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

function createSupabaseMock({ tableErrors = {} } = {}) {
  const state = {
    licenses: [{
      id: 'lic_1',
      email: 'healing@example.com',
      license_key: 'lic-healing-1',
      plan: 'free',
      status: 'active',
      billing_cycle: 'monthly',
      billing_day_of_month: 1
    }],
    sites: [],
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
    siteTrials: [],
    imageAltStates: [],
    generationRequests: [],
    quotaSummaries: [],
    usageLogs: []
  };

  let siteCounter = 1;
  let membershipCounter = 1;
  let siteQuotaCounter = 1;

  return {
    _state: state,
    from(table) {
      if (table === 'licenses') {
        return {
          select() {
            return createQuery(state.licenses);
          }
        };
      }

      if (table === 'sites') {
        return {
          select() {
            return createQuery(state.sites);
          },
          insert(payload) {
            const row = {
              id: `site_${siteCounter++}`,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
              ...payload
            };
            state.sites.push(row);
            return {
              select() {
                return {
                  single: jest.fn().mockResolvedValue({ data: row, error: null })
                };
              }
            };
          },
          update(payload) {
            return {
              eq(column, value) {
                const row = state.sites.find((site) => site[column] === value);
                if (row) Object.assign(row, payload);
                return {
                  select() {
                    return {
                      single: jest.fn().mockResolvedValue({
                        data: row || null,
                        error: null
                      })
                    };
                  },
                  then(resolve, reject) {
                    return Promise.resolve({ data: row || null, error: null }).then(resolve, reject);
                  }
                };
              }
            };
          }
        };
      }

      if (table === 'site_memberships') {
        return {
          select() {
            return createQuery(state.siteMemberships);
          },
          insert(payload) {
            const row = {
              id: `membership_${membershipCounter++}`,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
              ...payload
            };
            state.siteMemberships.push(row);
            return {
              select() {
                return {
                  single: jest.fn().mockResolvedValue({
                    data: row,
                    error: null
                  })
                };
              }
            };
          },
          update(payload) {
            return {
              eq(column, value) {
                const row = state.siteMemberships.find((membership) => membership[column] === value);
                if (row) Object.assign(row, payload);
                return {
                  select() {
                    return {
                      single: jest.fn().mockResolvedValue({
                        data: row || null,
                        error: null
                      })
                    };
                  }
                };
              }
            };
          }
        };
      }

      if (table === 'site_audit_logs') {
        return {
          select() {
            return createQuery(state.siteAuditLogs);
          },
          insert(payload) {
            state.siteAuditLogs.push(payload);
            return Promise.resolve({ data: payload, error: null });
          }
        };
      }

      if (table === 'plans') {
        return {
          select() {
            return createQuery(state.plans);
          }
        };
      }

      if (table === 'site_subscriptions') {
        return {
          select() {
            return createQuery(state.siteSubscriptions);
          }
        };
      }

      if (table === 'site_quotas') {
        return {
          select() {
            return createQuery(state.siteQuotas);
          },
          insert(payload) {
            const existing = state.siteQuotas.find((quota) => (
              quota.site_id === payload.site_id
              && quota.quota_period_start === payload.quota_period_start
              && quota.quota_period_end === payload.quota_period_end
            ));
            if (existing) {
              return {
                select() {
                  return {
                    single: jest.fn().mockResolvedValue({
                      data: null,
                      error: {
                        code: '23505',
                        message: 'duplicate key value violates unique constraint'
                      }
                    })
                  };
                }
              };
            }

            const row = {
              id: `site_quota_${siteQuotaCounter++}`,
              ...payload
            };
            state.siteQuotas.push(row);
            return {
              select() {
                return {
                  single: jest.fn().mockResolvedValue({
                    data: row,
                    error: null
                  })
                };
              }
            };
          }
        };
      }

      if (table === 'site_trials') {
        return {
          select() {
            return createQuery(state.siteTrials);
          }
        };
      }

      if (table === 'image_alt_states') {
        return {
          select(columns, options = {}) {
            return createQuery(state.imageAltStates, {
              countMode: Boolean(options?.head && options?.count === 'exact')
            }).select(columns, options);
          }
        };
      }

      if (table === 'generation_requests') {
        return {
          select() {
            return createQuery(state.generationRequests);
          }
        };
      }

      if (table === 'quota_summaries') {
        return {
          select() {
            return createQuery(state.quotaSummaries, { error: tableErrors.quota_summaries || null });
          }
        };
      }

      if (table === 'usage_logs') {
        return {
          select() {
            return createQuery(state.usageLogs, { error: tableErrors.usage_logs || null });
          }
        };
      }

      throw new Error(`Unexpected table: ${table}`);
    }
  };
}

function buildRequest(account, headers = {}) {
  return {
    id: 'req-healing-read',
    user: account,
    license: account,
    query: {},
    body: {},
    header(name) {
      return headers[name] || null;
    }
  };
}

function getCurrentQuotaWindow() {
  const start = new Date(Date.UTC(
    new Date().getUTCFullYear(),
    new Date().getUTCMonth(),
    1,
    0,
    0,
    0
  ));
  const end = new Date(start);
  end.setUTCMonth(end.getUTCMonth() + 1);
  return {
    quotaPeriodStart: start.toISOString(),
    quotaPeriodEnd: end.toISOString()
  };
}

function seedLinkedSiteWithStaleQuotaAndUsage(supabase, account, {
  creditsUsed = [1]
} = {}) {
  const { quotaPeriodStart, quotaPeriodEnd } = getCurrentQuotaWindow();
  const site = {
    id: 'site_existing',
    license_key: account.license_key,
    site_hash: 'site-legacy-credits',
    wp_install_uuid: 'site-legacy-credits',
    site_url: 'https://legacy-credits.example.com/wp-admin/',
    normalized_site_url: 'legacy-credits.example.com',
    canonical_domain: 'legacy-credits.example.com',
    site_fingerprint: 'fp-legacy-credits',
    status: 'active',
    owner_user_id: account.id,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    last_seen_at: new Date().toISOString(),
    first_seen_at: new Date().toISOString()
  };

  supabase._state.sites.push(site);
  supabase._state.siteQuotas.push({
    id: 'site_quota_existing',
    site_id: site.id,
    quota_period_start: quotaPeriodStart,
    quota_period_end: quotaPeriodEnd,
    monthly_included_credits: 50,
    purchased_credits_balance: 0,
    bonus_credits_balance: 0,
    used_credits: 0,
    remaining_credits: 50,
    reset_source: 'quota_read_healing',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  });

  creditsUsed.forEach((creditCount, index) => {
    const createdAt = new Date(Date.parse(quotaPeriodStart) + ((index + 1) * 60 * 1000)).toISOString();
    supabase._state.usageLogs.push({
      id: `usage_${index + 1}`,
      license_key: account.license_key,
      site_hash: site.site_hash,
      credits_used: creditCount,
      created_at: createdAt
    });
  });

  return {
    site,
    quotaPeriodStart,
    quotaPeriodEnd
  };
}

describe('authenticated site healing on read paths', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('legacy quota audit logs successful zero-row lookups without error null', async () => {
    const supabase = createSupabaseMock();
    const account = supabase._state.licenses[0];

    const result = await getQuotaStatus(supabase, {
      licenseKey: account.license_key,
      requestId: 'req-zero-rows'
    });

    expect(result.error).toBeUndefined();

    const rowsFoundPayloads = logger.info.mock.calls
      .filter(([message]) => message === '[bbai-credits] rows_found')
      .map(([, payload]) => payload);
    const usageRowsPayload = rowsFoundPayloads.find((payload) => payload.source_candidate === 'usage_logs');

    expect(usageRowsPayload).toEqual(expect.objectContaining({
      rows_found: 0,
      status: 'no_rows',
      reason: 'no_matching_usage_rows'
    }));
    expect(usageRowsPayload).not.toHaveProperty('error');
    expect(usageRowsPayload).not.toHaveProperty('license_key');

    const selectedPayload = logger.info.mock.calls
      .filter(([message]) => message === '[bbai-credits] source_selected')
      .map(([, payload]) => payload)
      .find((payload) => payload.request_id === 'req-zero-rows');
    expect(selectedPayload).toEqual(expect.objectContaining({
      fallback_reason: 'quota_summary_missing_and_usage_logs_empty',
      selected_source: 'fallback/default path',
      checked_sources: ['quota_summaries', 'usage_logs'],
      site_id: null,
      site_hash: null,
      license_key_prefix: 'lic-heal...'
    }));
  });

  test('legacy quota audit logs actual usage lookup errors explicitly', async () => {
    const usageError = {
      code: 'XX001',
      message: 'usage_logs unavailable'
    };
    const supabase = createSupabaseMock({
      tableErrors: {
        usage_logs: usageError
      }
    });
    const account = supabase._state.licenses[0];

    await getQuotaStatus(supabase, {
      licenseKey: account.license_key,
      requestId: 'req-usage-error'
    });

    const usageRowsPayload = logger.warn.mock.calls
      .filter(([message]) => message === '[bbai-credits] rows_found')
      .map(([, payload]) => payload)
      .find((payload) => payload.source_candidate === 'usage_logs');

    expect(usageRowsPayload).toEqual(expect.objectContaining({
      rows_found: 0,
      status: 'error',
      error_message: 'usage_logs unavailable',
      error_code: 'XX001',
      error: expect.objectContaining({
        code: 'XX001',
        message: 'usage_logs unavailable'
      })
    }));
    expect(usageRowsPayload).not.toHaveProperty('reason');
  });

  test('quota status self-heals missing canonical site and returns a non-null site', async () => {
    const supabase = createSupabaseMock();
    const account = supabase._state.licenses[0];

    const result = await getQuotaStatus(supabase, {
      account,
      licenseKey: account.license_key,
      siteHash: 'site-read-heal',
      installUuid: 'site-read-heal',
      siteUrl: 'https://read-heal.example.com/wp-admin/',
      siteFingerprint: 'fp-read-heal',
      requestId: 'req-quota-heal'
    });

    expect(result.error).toBeNull();
    expect(result.site).toEqual(expect.objectContaining({
      id: expect.any(String),
      site_hash: 'site-read-heal'
    }));
    expect(result.site_quota).toEqual(expect.objectContaining({
      site_id: result.site.id,
      monthly_included_credits: 50,
      purchased_credits_balance: 0,
      bonus_credits_balance: 0
    }));
    expect(result.credits_remaining).toBe(50);
    expect(supabase._state.siteQuotas).toHaveLength(1);
    expect(supabase._state.siteQuotas[0]).toEqual(expect.objectContaining({
      site_id: result.site.id,
      quota_period_start: expect.stringMatching(/T00:00:00\.000Z$/),
      quota_period_end: expect.stringMatching(/T00:00:00\.000Z$/),
      monthly_included_credits: 50,
      purchased_credits_balance: 0,
      bonus_credits_balance: 0,
      used_credits: 0,
      remaining_credits: 50,
      created_at: expect.any(String),
      updated_at: expect.any(String)
    }));
    expect(supabase._state.siteMemberships).toEqual(expect.arrayContaining([
      expect.objectContaining({
        site_id: result.site.id,
        user_id: account.id
      })
    ]));
  });

  test('quota initialization is idempotent for repeated healed reads', async () => {
    const supabase = createSupabaseMock();
    const account = supabase._state.licenses[0];
    const request = {
      account,
      licenseKey: account.license_key,
      siteHash: 'site-quota-idempotent',
      installUuid: 'site-quota-idempotent',
      siteUrl: 'https://quota-idempotent.example.com/wp-admin/',
      siteFingerprint: 'fp-quota-idempotent',
      requestId: 'req-quota-idempotent'
    };

    const first = await getQuotaStatus(supabase, request);
    const second = await getQuotaStatus(supabase, request);

    expect(first.error).toBeNull();
    expect(second.error).toBeNull();
    expect(first.site.id).toBe(second.site.id);
    expect(supabase._state.siteQuotas).toHaveLength(1);
    expect(second.site_quota).toEqual(expect.objectContaining({
      site_id: first.site.id,
      monthly_included_credits: 50,
      remaining_credits: 50
    }));
  });

  test('dashboard truth resolves a linked site_id after authenticated read-path healing', async () => {
    const supabase = createSupabaseMock();
    const account = supabase._state.licenses[0];
    const req = buildRequest(account, {
      'X-License-Key': account.license_key,
      'X-Site-Key': 'site-dashboard-heal',
      'X-Install-UUID': 'site-dashboard-heal',
      'X-Site-URL': 'https://dashboard-heal.example.com/wp-admin/',
      'X-Site-Fingerprint': 'fp-dashboard-heal'
    });

    const result = await buildDashboardStateTruth({
      supabase,
      req,
      getJobRecord: async () => null
    });

    expect(result.success).toBe(true);
    expect(result.site).toEqual(expect.objectContaining({
      site_id: expect.any(String),
      site_hash: 'site-dashboard-heal',
      linked: true
    }));
  });

  test('quota status prefers legacy usage logs when site_quotas is a stale zero row', async () => {
    const supabase = createSupabaseMock();
    const account = supabase._state.licenses[0];
    seedLinkedSiteWithStaleQuotaAndUsage(supabase, account, {
      creditsUsed: [2, 3]
    });

    const result = await getQuotaStatus(supabase, {
      account,
      licenseKey: account.license_key,
      siteHash: 'site-legacy-credits',
      installUuid: 'site-legacy-credits',
      siteUrl: 'https://legacy-credits.example.com/wp-admin/',
      siteFingerprint: 'fp-legacy-credits',
      requestId: 'req-legacy-usage-heal'
    });

    expect(result.error).toBeNull();
    expect(result.total_limit).toBe(50);
    expect(result.credits_used).toBe(5);
    expect(result.credits_remaining).toBe(45);
    expect(result.site_quota).toEqual(expect.objectContaining({
      site_id: 'site_existing',
      used_credits: 5,
      remaining_credits: 45
    }));
    expect(supabase._state.siteQuotas[0]).toEqual(expect.objectContaining({
      used_credits: 0,
      remaining_credits: 50
    }));
  });

  test('quota status keeps paid site_quotas authoritative when legacy usage logs are higher', async () => {
    const supabase = createSupabaseMock();
    const account = supabase._state.licenses[0];
    account.plan = 'pro';
    supabase._state.plans.push({
      id: 'pro',
      display_name: 'Pro',
      monthly_included_credits: 1000,
      credit_grant_amount: 1000,
      billing_interval_default: 'month',
      is_paid: true
    });
    const { site, quotaPeriodStart, quotaPeriodEnd } = seedLinkedSiteWithStaleQuotaAndUsage(supabase, account, {
      creditsUsed: [52]
    });
    supabase._state.siteQuotas[0] = {
      ...supabase._state.siteQuotas[0],
      monthly_included_credits: 1000,
      used_credits: 49,
      remaining_credits: 951
    };
    supabase._state.siteSubscriptions.push({
      id: 'site_sub_pro',
      site_id: site.id,
      plan_id: 'pro',
      status: 'active',
      stripe_customer_id: 'cus_pro',
      stripe_subscription_id: 'sub_pro',
      billing_interval: 'month',
      current_period_start: quotaPeriodStart,
      current_period_end: quotaPeriodEnd
    });

    const result = await getQuotaStatus(supabase, {
      account,
      licenseKey: account.license_key,
      siteHash: 'site-legacy-credits',
      installUuid: 'site-legacy-credits',
      siteUrl: 'https://legacy-credits.example.com/wp-admin/',
      siteFingerprint: 'fp-legacy-credits',
      requestId: 'req-paid-site-quota-authoritative'
    });

    expect(result.error).toBeNull();
    expect(result.plan_type).toBe('pro');
    expect(result.total_limit).toBe(1000);
    expect(result.credits_used).toBe(49);
    expect(result.credits_remaining).toBe(951);
    expect(result.site_quota).toEqual(expect.objectContaining({
      site_id: 'site_existing',
      used_credits: 49,
      remaining_credits: 951
    }));
    expect(logger.info).toHaveBeenCalledWith(
      '[bbai-credits] source_selected',
      expect.objectContaining({
        selected_source: 'site_quotas',
        fallback_reason: 'paid_site_quota_authoritative',
        used: 49,
        remaining: 951
      })
    );
  });

  test('quota status demotes stale legacy growth account without active subscription evidence', async () => {
    const supabase = createSupabaseMock();
    const account = supabase._state.licenses[0];
    account.plan = 'growth';
    account.stripe_subscription_id = null;
    supabase._state.plans.push({
      id: 'growth',
      display_name: 'Growth',
      monthly_included_credits: 1000,
      credit_grant_amount: 1000,
      billing_interval_default: 'month',
      is_paid: true
    });
    seedLinkedSiteWithStaleQuotaAndUsage(supabase, account, {
      creditsUsed: [1, 2]
    });
    supabase._state.siteQuotas[0] = {
      ...supabase._state.siteQuotas[0],
      monthly_included_credits: 1000,
      used_credits: 3,
      remaining_credits: 997
    };

    const result = await getQuotaStatus(supabase, {
      account,
      licenseKey: account.license_key,
      siteHash: 'site-legacy-credits',
      installUuid: 'site-legacy-credits',
      siteUrl: 'https://legacy-credits.example.com/wp-admin/',
      siteFingerprint: 'fp-legacy-credits',
      requestId: 'req-stale-growth-demoted'
    });

    expect(result.error).toBeNull();
    expect(result.plan_type).toBe('free');
    expect(result.total_limit).toBe(50);
    expect(result.credits_used).toBe(3);
    expect(result.credits_remaining).toBe(47);
    expect(result.site_quota).toEqual(expect.objectContaining({
      site_id: 'site_existing',
      monthly_included_credits: 50,
      used_credits: 3,
      remaining_credits: 47
    }));
  });

  test('dashboard truth returns healed credit usage instead of stale site quota defaults', async () => {
    const supabase = createSupabaseMock();
    const account = supabase._state.licenses[0];
    seedLinkedSiteWithStaleQuotaAndUsage(supabase, account, {
      creditsUsed: [4, 1]
    });
    const req = buildRequest(account, {
      'X-License-Key': account.license_key,
      'X-Site-Key': 'site-legacy-credits',
      'X-Install-UUID': 'site-legacy-credits',
      'X-Site-URL': 'https://legacy-credits.example.com/wp-admin/',
      'X-Site-Fingerprint': 'fp-legacy-credits'
    });

    const result = await buildDashboardStateTruth({
      supabase,
      req,
      getJobRecord: async () => null
    });

    expect(result.success).toBe(true);
    expect(result.credits).toEqual(expect.objectContaining({
      limit: 50,
      used: 5,
      remaining: 45,
      source: 'license'
    }));
    expect(result.resolution.credit_source).toBe('getQuotaStatus');
    expect(result.site).toEqual(expect.objectContaining({
      site_id: 'site_existing',
      site_hash: 'site-legacy-credits',
      linked: true
    }));
  });

  test('image state site context self-heals for authenticated requests even when createIfMissing is false', async () => {
    const supabase = createSupabaseMock();
    const account = supabase._state.licenses[0];
    const req = buildRequest(account, {
      'X-License-Key': account.license_key,
      'X-Site-Key': 'site-image-heal',
      'X-Install-UUID': 'site-image-heal',
      'X-Site-URL': 'https://image-heal.example.com/wp-admin/',
      'X-Site-Fingerprint': 'fp-image-heal'
    });

    const resolved = await resolveImageAltStateSiteContext(supabase, req, {
      createIfMissing: false
    });

    expect(resolved.error).toBeNull();
    expect(resolved.site).toEqual(expect.objectContaining({
      id: expect.any(String),
      site_hash: 'site-image-heal'
    }));
    expect(supabase._state.siteMemberships).toEqual(expect.arrayContaining([
      expect.objectContaining({
        site_id: resolved.site.id,
        user_id: account.id
      })
    ]));
  });
});
