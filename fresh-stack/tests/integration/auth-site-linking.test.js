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
      siteAuditLogs
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

    expect(first.status).toBe(201);
    expect(first.body.shared_site).toBe(false);
    expect(first.body.site.id).toBeTruthy();

    const second = await request(app)
      .post('/auth/register')
      .send({
        email: 'editor@example.com',
        password: 'Password123!',
        ...sharedSitePayload
      });

    expect(second.status).toBe(201);
    expect(second.body.shared_site).toBe(true);
    expect(second.body.site.id).toBe(first.body.site.id);
    expect(second.body.existing_email).toBe('ow***@example.com');
    expect(supabase._state.sites).toHaveLength(1);
    expect(supabase._state.siteMemberships).toHaveLength(2);
    expect(new Set(supabase._state.siteMemberships.map((membership) => membership.user_id)).size).toBe(2);
  });
});
