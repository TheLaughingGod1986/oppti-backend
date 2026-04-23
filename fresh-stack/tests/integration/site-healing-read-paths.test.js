const { getQuotaStatus } = require('../../services/quota');
const { buildDashboardStateTruth } = require('../../services/dashboardStateTruth');
const { resolveImageAltStateSiteContext } = require('../../services/imageAltState');

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

function createSupabaseMock() {
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
            return createQuery(state.quotaSummaries);
          }
        };
      }

      if (table === 'usage_logs') {
        return {
          select() {
            return createQuery(state.usageLogs);
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

describe('authenticated site healing on read paths', () => {
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
