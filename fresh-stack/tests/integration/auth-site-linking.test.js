const express = require('express');
const request = require('supertest');

process.env.JWT_SECRET = 'test-jwt-secret';

jest.mock('../../../src/services/loops', () => ({
  trackAccountCreated: jest.fn().mockResolvedValue(undefined)
}));

jest.mock('../../services/quota', () => ({
  getQuotaStatus: jest.fn().mockResolvedValue({
    error: null,
    plan_type: 'free',
    credits_used: 0,
    credits_remaining: 50,
    total_limit: 50,
    reset_date: '2026-06-25T00:00:00.000Z'
  })
}));

const { createAuthRouter } = require('../../routes/auth');
const { createLicenseRouter } = require('../../routes/license');

const LEGACY_UNSUPPORTED_SITE_COLUMNS = [
  'site_fingerprint',
  'wp_install_uuid',
  'normalized_site_url',
  'canonical_domain',
  'owner_user_id',
  'merged_into_site_id',
  'first_seen_at',
  'last_seen_at',
  'updated_at',
  'environment'
];
const LEGACY_SITE_KEYS = [
  'license_key',
  'site_hash',
  'site_url',
  'site_name',
  'fingerprint',
  'status',
  'activated_at',
  'last_activity_at',
  'deactivated_at'
];

function createMissingSchemaError(subject = 'column') {
  return {
    code: '42703',
    message: `${subject} does not exist`
  };
}

function selectionUsesLegacyUnsupportedSiteColumns(selection = '') {
  return LEGACY_UNSUPPORTED_SITE_COLUMNS.some((column) => selection.includes(column));
}

function payloadUsesLegacyUnsupportedSiteColumns(payload = {}) {
  return Object.keys(payload).some((key) => LEGACY_UNSUPPORTED_SITE_COLUMNS.includes(key));
}

function stripToLegacySitePayload(payload = {}) {
  return Object.fromEntries(
    Object.entries(payload).filter(([key]) => LEGACY_SITE_KEYS.includes(key))
  );
}

function createSupabaseMock({
  legacySiteSchema = false,
  missingSiteMembershipsTable = false
} = {}) {
  const licenses = [];
  const sites = [];
  const siteMemberships = [];
  const siteAuditLogs = [];
  const siteTrials = [];
  let licenseCounter = 1;
  let siteCounter = 1;
  let membershipCounter = 1;

  function buildFilterableChain(rows, error = null) {
    const state = { rows: rows.slice() };

    const chain = {
      eq(column, value) {
        state.rows = state.rows.filter((row) => row[column] === value);
        return chain;
      },
      in(column, values) {
        state.rows = state.rows.filter((row) => Array.isArray(values) && values.includes(row[column]));
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
        data: error ? null : (state.rows[0] || null),
        error
      })),
      single: jest.fn().mockImplementation(async () => ({
        data: error ? null : (state.rows[0] || null),
        error
      })),
      then(resolve, reject) {
        return Promise.resolve({
          data: error ? null : state.rows,
          error
        }).then(resolve, reject);
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
          select(selection = '') {
            if (legacySiteSchema && selectionUsesLegacyUnsupportedSiteColumns(selection)) {
              return buildFilterableChain([], createMissingSchemaError('sites v2 column'));
            }
            return buildFilterableChain(sites);
          },
          insert(payload) {
            const unsupportedError = legacySiteSchema && payloadUsesLegacyUnsupportedSiteColumns(payload)
              ? createMissingSchemaError('sites v2 column')
              : null;
            const normalizedPayload = legacySiteSchema
              ? stripToLegacySitePayload(payload)
              : payload;
            const row = {
              id: `site_${siteCounter++}`,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
              ...normalizedPayload
            };
            if (!unsupportedError) {
              sites.push(row);
            }
            return {
              select(selection = '') {
                const selectionError = legacySiteSchema && selectionUsesLegacyUnsupportedSiteColumns(selection)
                  ? createMissingSchemaError('sites v2 column')
                  : unsupportedError;
                return {
                  single: jest.fn().mockResolvedValue({
                    data: selectionError ? null : row,
                    error: selectionError
                  })
                };
              }
            };
          },
          update(payload) {
            return {
              eq(column, value) {
                const unsupportedError = legacySiteSchema && payloadUsesLegacyUnsupportedSiteColumns(payload)
                  ? createMissingSchemaError('sites v2 column')
                  : null;
                const row = sites.find((site) => site[column] === value);
                if (row && !unsupportedError) {
                  Object.assign(row, legacySiteSchema ? stripToLegacySitePayload(payload) : payload);
                }
                return {
                  select(selection = '') {
                    const selectionError = legacySiteSchema && selectionUsesLegacyUnsupportedSiteColumns(selection)
                      ? createMissingSchemaError('sites v2 column')
                      : unsupportedError;
                    return {
                      single: jest.fn().mockResolvedValue({
                        data: selectionError ? null : (row || null),
                        error: selectionError
                      })
                    };
                  },
                  then: (resolve, reject) => Promise.resolve({
                    data: unsupportedError ? null : (row || null),
                    error: unsupportedError
                  }).then(resolve, reject)
                };
              }
            };
          }
        };
      }

      if (table === 'site_memberships') {
        if (missingSiteMembershipsTable) {
          const schemaError = createMissingSchemaError('site_memberships table');
          return {
            select() {
              return buildFilterableChain([], schemaError);
            },
            insert() {
              return {
                select() {
                  return {
                    single: jest.fn().mockResolvedValue({
                      data: null,
                      error: schemaError
                    })
                  };
                }
              };
            },
            update() {
              return {
                eq() {
                  return {
                    select() {
                      return {
                        single: jest.fn().mockResolvedValue({
                          data: null,
                          error: schemaError
                        })
                      };
                    }
                  };
                }
              };
            }
          };
        }
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

function createApp(supabase, { includeLicenseRoutes = false } = {}) {
  const app = express();
  app.use(express.json());
  app.use('/auth', createAuthRouter({ supabase }));
  if (includeLicenseRoutes) {
    app.use('/api/license', createLicenseRouter({ supabase }));
    app.use('/api/licenses', createLicenseRouter({ supabase }));
  }
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
    expect(first.body.message).toBe('Account created. Your free monthly credits are now active.');
    expect(first.body.entitlement_state).toEqual(expect.objectContaining({
      plan: 'free',
      tokens_remaining: 50,
      can_generate: true,
      is_logged_in: true
    }));

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

  test('registration resolves sandbox payload by site_hash alias before ambiguous domain matching', async () => {
    const supabase = createSupabaseMock();
    const targetSite = {
      id: 'site_sandbox_target',
      license_key: null,
      site_hash: 'sandbox-install-target',
      wp_install_uuid: 'sandbox-install-target',
      site_url: 'https://eu2.wpsandbox.org/site/s-target',
      normalized_site_url: 'eu2.wpsandbox.org/site/s-target',
      canonical_domain: 'eu2.wpsandbox.org',
      site_fingerprint: 'sandbox-fingerprint-target',
      status: 'active',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    supabase._state.sites.push(
      targetSite,
      {
        id: 'site_sandbox_other',
        license_key: null,
        site_hash: 'sandbox-install-other',
        wp_install_uuid: 'sandbox-install-other',
        site_url: 'https://eu2.wpsandbox.org/site/s-other',
        normalized_site_url: 'eu2.wpsandbox.org/site/s-other',
        canonical_domain: 'eu2.wpsandbox.org',
        site_fingerprint: 'sandbox-fingerprint-other',
        status: 'active',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }
    );

    const app = createApp(supabase);
    const res = await request(app)
      .post('/auth/register')
      .send({
        email: 'sandbox-alias@example.com',
        password: 'Password123!',
        site_hash: 'sandbox-install-target',
        site_key: 'sandbox-install-target',
        install_id: 'sandbox-install-target',
        site_install_id: 'sandbox-install-target',
        site_url: 'https://eu2.wpsandbox.org/wp-admin/'
      });

    expect(res.status).toBe(200);
    expect(res.body.code).not.toBe('AMBIGUOUS_SITE_MATCH');
    expect(res.body.site).toEqual(expect.objectContaining({
      id: targetSite.id,
      site_hash: targetSite.site_hash
    }));
    expect(supabase._state.siteAuditLogs).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ event_type: 'ambiguous_site_match' })
    ]));
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

  test('localhost installs do not merge solely by normalized URL or canonical domain', async () => {
    const supabase = createSupabaseMock();
    supabase._state.sites.push({
      id: 'site_existing_localhost',
      license_key: 'license-existing-localhost',
      site_hash: 'localhost-existing',
      wp_install_uuid: 'localhost-existing',
      site_url: 'http://localhost:8080/wp-admin/',
      normalized_site_url: 'localhost:8080/wp-admin',
      canonical_domain: 'localhost',
      fingerprint: 'localhost-fingerprint-old',
      site_fingerprint: 'localhost-fingerprint-old',
      status: 'active',
      activated_at: new Date().toISOString(),
      last_activity_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    });

    const app = createApp(supabase);
    const res = await request(app)
      .post('/auth/register')
      .send({
        email: 'localhost-new@example.com',
        password: 'Password123!',
        site_id: 'localhost-new-install',
        install_uuid: 'localhost-new-install',
        site_url: 'http://localhost:8080/wp-admin/',
        site_fingerprint: 'localhost-fingerprint-new'
      });

    expect(res.status).toBe(200);
    expect(res.body.site).toEqual(expect.objectContaining({
      site_hash: 'localhost-new-install',
      fingerprint: 'localhost-fingerprint-new'
    }));
    expect(res.body.site.id).not.toBe('site_existing_localhost');
    expect(supabase._state.sites).toHaveLength(2);
  });

  test('login with site context heals linkage and returns the current canonical site immediately', async () => {
    const supabase = createSupabaseMock();
    const app = createApp(supabase, { includeLicenseRoutes: true });

    const register = await request(app)
      .post('/auth/register')
      .send({
        email: 'login-heal@example.com',
        password: 'Password123!'
      });

    expect(register.status).toBe(200);
    expect(register.body.site).toBeNull();

    const login = await request(app)
      .post('/auth/login')
      .send({
        email: 'login-heal@example.com',
        password: 'Password123!',
        site_id: 'wp-login-heal',
        install_uuid: 'wp-login-heal',
        site_url: 'https://heal.example.com/wp-admin/',
        site_fingerprint: 'fingerprint-login-heal'
      });

    expect(login.status).toBe(200);
    expect(login.body.site).toEqual(expect.objectContaining({
      id: expect.any(String),
      site_hash: 'wp-login-heal'
    }));
    expect(login.body.entitlement_state).toEqual(expect.objectContaining({
      plan: 'free',
      tokens_remaining: 50,
      can_generate: true,
      is_logged_in: true
    }));
    expect(supabase._state.siteMemberships).toEqual(expect.arrayContaining([
      expect.objectContaining({
        site_id: login.body.site.id,
        user_id: register.body.user.id
      })
    ]));
  });

  test('authenticated /api/licenses/sites self-heals from X-Site headers and returns the linked site', async () => {
    const supabase = createSupabaseMock();
    const app = createApp(supabase, { includeLicenseRoutes: true });

    const register = await request(app)
      .post('/auth/register')
      .send({
        email: 'license-sites-heal@example.com',
        password: 'Password123!'
      });

    expect(register.status).toBe(200);
    expect(register.body.site).toBeNull();

    const sitesRes = await request(app)
      .get('/api/licenses/sites')
      .set('X-License-Key', register.body.user.license_key)
      .set('X-Site-Key', 'wp-license-heal')
      .set('X-Install-UUID', 'wp-license-heal')
      .set('X-Site-URL', 'https://license-heal.example.com/wp-admin/')
      .set('X-Site-Fingerprint', 'fingerprint-license-heal');

    expect(sitesRes.status).toBe(200);
    expect(sitesRes.body.sites).toHaveLength(1);
    expect(sitesRes.body.sites[0]).toEqual(expect.objectContaining({
      id: expect.any(String),
      site_hash: 'wp-license-heal'
    }));

    const siteId = sitesRes.body.sites[0].id;
    expect(supabase._state.siteMemberships).toEqual(expect.arrayContaining([
      expect.objectContaining({
        site_id: siteId,
        user_id: register.body.user.id
      })
    ]));
  });

  test('register/login still link and return a site when only the legacy sites schema is available', async () => {
    const supabase = createSupabaseMock({
      legacySiteSchema: true,
      missingSiteMembershipsTable: true
    });
    const app = createApp(supabase, { includeLicenseRoutes: true });
    const payload = {
      email: 'legacyschema@example.com',
      password: 'Password123!',
      site_id: 'legacy-install',
      install_uuid: 'legacy-install',
      site_url: 'http://localhost:8080/wp-admin/',
      site_fingerprint: 'legacy-fingerprint'
    };

    const register = await request(app)
      .post('/auth/register')
      .send(payload);

    expect(register.status).toBe(200);
    expect(register.body.site).toEqual(expect.objectContaining({
      id: expect.any(String),
      site_hash: 'legacy-install',
      site_url: 'http://localhost:8080/wp-admin/',
      fingerprint: 'legacy-fingerprint',
      license_key: register.body.user.license_key
    }));

    const login = await request(app)
      .post('/auth/login')
      .send(payload);

    expect(login.status).toBe(200);
    expect(login.body.site).toEqual(expect.objectContaining({
      id: register.body.site.id,
      site_hash: 'legacy-install',
      license_key: register.body.user.license_key
    }));

    const sitesRes = await request(app)
      .get('/api/license/sites')
      .set('X-License-Key', register.body.user.license_key);

    expect(sitesRes.status).toBe(200);
    expect(sitesRes.body.sites).toHaveLength(1);
    expect(sitesRes.body.sites[0]).toEqual(expect.objectContaining({
      id: register.body.site.id,
      site_hash: 'legacy-install',
      license_key: register.body.user.license_key
    }));
    expect(supabase._state.siteMemberships).toHaveLength(0);
  });
});
