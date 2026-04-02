const express = require('express');
const request = require('supertest');

process.env.JWT_SECRET = 'test-jwt-secret';

jest.mock('../../../src/services/loops', () => ({
  trackAccountCreated: jest.fn().mockResolvedValue(undefined)
}));

const { createAuthRouter } = require('../../routes/auth');

function createSupabaseMock() {
  const licenses = [];
  const sites = [];
  const siteMemberships = [];
  const siteAuditLogs = [];
  const siteTrials = [];
  let licenseCounter = 1;
  let siteCounter = 1;
  let membershipCounter = 1;

  function buildFilterableChain(rows) {
    const state = { rows: rows.slice() };

    const chain = {
      eq(column, value) {
        state.rows = state.rows.filter((row) => row[column] === value);
        return chain;
      },
      order(column, options = {}) {
        const ascending = options.ascending !== false;
        state.rows = state.rows.slice().sort((left, right) => {
          if (left[column] === right[column]) return 0;
          if (left[column] === undefined) return 1;
          if (right[column] === undefined) return -1;
          return ascending
            ? (left[column] > right[column] ? 1 : -1)
            : (left[column] < right[column] ? 1 : -1);
        });
        return chain;
      },
      limit(count) {
        state.rows = state.rows.slice(0, count);
        return chain;
      },
      maybeSingle: jest.fn().mockImplementation(async () => ({
        data: state.rows[0] || null,
        error: null
      })),
      single: jest.fn().mockImplementation(async () => ({
        data: state.rows[0] || null,
        error: null
      })),
      then(resolve, reject) {
        return Promise.resolve({ data: state.rows, error: null }).then(resolve, reject);
      }
    };

    return chain;
  }

  return {
    _state: {
      licenses,
      sites,
      siteMemberships,
      siteAuditLogs,
      siteTrials
    },
    from(table) {
      if (table === 'licenses') {
        return {
          select() {
            return buildFilterableChain(licenses);
          },
          insert(payload) {
            const row = {
              id: `license_${licenseCounter++}`,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
              ...payload
            };
            licenses.push(row);
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
                const row = licenses.find((license) => license[column] === value);
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
                  then: (resolve, reject) => Promise.resolve({ data: row || null, error: null }).then(resolve, reject)
                };
              }
            };
          }
        };
      }

      if (table === 'sites') {
        return {
          select() {
            return buildFilterableChain(sites);
          },
          insert(payload) {
            const row = {
              id: `site_${siteCounter++}`,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
              ...payload
            };
            sites.push(row);
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
                const row = sites.find((site) => site[column] === value);
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
                  then: (resolve, reject) => Promise.resolve({ data: row || null, error: null }).then(resolve, reject)
                };
              }
            };
          }
        };
      }

      if (table === 'site_memberships') {
        return {
          select() {
            return buildFilterableChain(siteMemberships);
          },
          insert(payload) {
            const row = {
              id: `membership_${membershipCounter++}`,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
              ...payload
            };
            siteMemberships.push(row);
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

      if (table === 'site_audit_logs') {
        return {
          insert(payload) {
            siteAuditLogs.push(payload);
            return Promise.resolve({ data: payload, error: null });
          }
        };
      }

      if (table === 'site_trials') {
        return {
          select() {
            return buildFilterableChain(siteTrials);
          }
        };
      }

      if (table === 'trial_usage') {
        return {
          select() {
            return buildFilterableChain([]);
          }
        };
      }

      throw new Error(`Unexpected table: ${table}`);
    }
  };
}

function createApp(supabase) {
  const app = express();
  app.use(express.json());
  app.use('/auth', createAuthRouter({ supabase }));
  return app;
}

describe('site-aware auth linking', () => {
  test('same site registered with two emails resolves to one canonical site and shared membership', async () => {
    const supabase = createSupabaseMock();
    const app = createApp(supabase);
    const sharedSitePayload = {
      site_id: 'wp-install-shared',
      install_uuid: 'wp-install-shared',
      site_url: 'https://Example.com/wp-admin/',
      site_fingerprint: 'fingerprint-shared'
    };

    const first = await request(app)
      .post('/auth/register')
      .send({
        email: 'owner@example.com',
        password: 'Password123!',
        ...sharedSitePayload
      });

    expect(first.status).toBe(200);
    expect(first.body.shared_site).toBe(false);
    expect(first.body.site.id).toBeTruthy();

    const second = await request(app)
      .post('/auth/register')
      .send({
        email: 'editor@example.com',
        password: 'Password123!',
        ...sharedSitePayload
      });

    expect(second.status).toBe(200);
    expect(second.body.shared_site).toBe(true);
    expect(second.body.site.id).toBe(first.body.site.id);
    expect(second.body.existing_email).toBe('ow***@example.com');
    expect(supabase._state.sites).toHaveLength(1);
    expect(supabase._state.siteMemberships).toHaveLength(2);
    expect(new Set(supabase._state.siteMemberships.map((membership) => membership.user_id)).size).toBe(2);
  });

  test('registration records anonymous trial merge when the site already has trial usage', async () => {
    const supabase = createSupabaseMock();
    const existingSite = {
      id: 'site_existing',
      site_hash: 'wp-install-anon',
      wp_install_uuid: 'wp-install-anon',
      site_fingerprint: 'fingerprint-anon',
      site_url: 'https://example.com',
      normalized_site_url: 'example.com',
      canonical_domain: 'example.com',
      status: 'active',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    supabase._state.sites.push(existingSite);
    supabase._state.siteTrials.push({
      id: 'trial_existing',
      site_id: existingSite.id,
      total_trial_credits: 5,
      used_trial_credits: 2,
      status: 'active',
      created_at: new Date().toISOString()
    });

    const app = createApp(supabase);
    const res = await request(app)
      .post('/auth/register')
      .send({
        email: 'trialmerge@example.com',
        password: 'Password123!',
        site_id: 'wp-install-anon',
        install_uuid: 'wp-install-anon',
        site_url: 'https://example.com',
        site_fingerprint: 'fingerprint-anon',
        anon_id: 'anon-dashboard-merge'
      });

    expect(res.status).toBe(200);
    expect(res.body.site.id).toBe(existingSite.id);
    expect(supabase._state.siteAuditLogs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        event_type: 'register_anonymous_trial_merged',
        site_id: existingSite.id,
        metadata: expect.objectContaining({
          anon_id: 'anon-dashboard-merge',
          anonymous_usage_used: 2,
          anonymous_usage_limit: 5,
          anonymous_usage_source: 'site_trials'
        })
      })
    ]));
  });
});
