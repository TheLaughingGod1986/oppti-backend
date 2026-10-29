const express = require('express');
const request = require('supertest');

process.env.JWT_SECRET = 'test-jwt-secret';

jest.mock('../../../src/services/loops', () => ({
  trackAccountCreated: jest.fn().mockResolvedValue(undefined)
}));

jest.mock('../../lib/posthog', () => ({
  identifyServerUser: jest.fn().mockResolvedValue({ ok: true }),
  captureServerEvent: jest.fn().mockResolvedValue({ ok: true }),
  aliasServerUser: jest.fn().mockResolvedValue({ ok: true })
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
  missingSiteMembershipsTable = false,
  pluginConnectionInsertError = null
} = {}) {
  const licenses = [];
  const sites = [];
  const siteMemberships = [];
  const siteAuditLogs = [];
  const siteTrials = [];
  const pluginConnections = [];
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

      // Registration and login record which OpptiAI plugin connected, via
      // services/pluginConnections.js: select -> update (existing) or insert.
      // Without this handler the mock threw `Unexpected table`, the auth route
      // caught it and returned SERVER_ERROR — but sendRegisterResponse always
      // replies 200, so `expect(res.status).toBe(200)` still passed and the
      // failure only surfaced as missing response fields.
      if (table === 'account_plugin_connections') {
        return {
          select() {
            return buildFilterableChain(pluginConnections);
          },
          insert(payload) {
            if (pluginConnectionInsertError) {
              return Promise.resolve({ data: null, error: pluginConnectionInsertError });
            }
            const row = {
              id: `plugin_connection_${pluginConnections.length + 1}`,
              first_connected_at: new Date().toISOString(),
              ...payload
            };
            pluginConnections.push(row);
            return Promise.resolve({ data: row, error: null });
          },
          update(patch) {
            return {
              eq(column, value) {
                const row = pluginConnections.find((entry) => entry[column] === value);
                if (row) Object.assign(row, patch);
                return Promise.resolve({ data: row || null, error: null });
              }
            };
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
  test.each([null, {
    code: '23514',
    message: 'account_plugin_connections_plugin_id_check violated'
  }])('internal linking register/login succeeds with connection insert error %j', async (pluginConnectionInsertError) => {
    const supabase = createSupabaseMock({ pluginConnectionInsertError });
    const app = createApp(supabase);
    const credentials = {
      email: 'internal-linking@example.com',
      password: 'Password123!',
      plugin_id: 'internal_linking',
      plugin_version: '1.0.0'
    };
    const logger = require('../../lib/logger');
    const warning = jest.spyOn(logger, 'warn');
    try {
      const registered = await request(app).post('/auth/register').send(credentials).expect(200);
      expect(registered.body.success).toBe(true);
      const loggedIn = await request(app).post('/auth/login').send(credentials).expect(200);
      expect(loggedIn.body.success).toBe(true);
      if (pluginConnectionInsertError) {
        expect(warning).toHaveBeenCalledWith('[auth] plugin_connection_state_failed', expect.objectContaining({
          plugin_id: 'internal_linking',
          error: pluginConnectionInsertError.message
        }));
      }
    } finally {
      warning.mockRestore();
    }
  });

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

describe('register stores Website Auditor attribution', () => {
  const base = { password: 'Password123!', plugin_version: '1.0.0' };

  async function register(body, supabase = createSupabaseMock()) {
    const res = await request(createApp(supabase)).post('/auth/register').send(body);
    return { res, supabase };
  }

  test('new id is stored with flag and signup plugin', async () => {
    const { res, supabase } = await register({ ...base, email: 'aud-new@example.com', plugin_id: 'titles', finding: 'canonical_missing', auditor_source: 'canonical_missing' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const row = supabase._state.licenses.find((l) => l.email === 'aud-new@example.com');
    expect(row).toMatchObject({ auditor_finding: 'canonical_missing', signup_source_auditor: true, signup_plugin: 'titles' });
  });

  test.each(['missing_title', 'duplicate_title'])('%s is stored', async (id) => {
    const email = `aud-${id}@example.com`;
    const { res, supabase } = await register({ ...base, email, plugin_id: 'titles', finding: id });
    expect(res.status).toBe(200);
    const row = supabase._state.licenses.find((l) => l.email === email);
    expect(row).toMatchObject({ auditor_finding: id, signup_source_auditor: true, signup_plugin: 'titles' });
  });

  test('old id is mapped', async () => {
    const { res, supabase } = await register({ ...base, email: 'aud-old@example.com', auditor_source: 'open_graph' });
    expect(res.status).toBe(200);
    const row = supabase._state.licenses.find((l) => l.email === 'aud-old@example.com');
    expect(row).toMatchObject({ auditor_finding: 'og_tags_missing', signup_source_auditor: true, signup_plugin: 'alt_text' });
  });

  test.each([
    ['unknown', { finding: 'internal_links' }],
    ['over 64 chars', { finding: 'x'.repeat(71) }],
    ['non-string', { finding: { a: 1 }, auditor_source: 123 }],
    ['missing', {}]
  ])('%s value still registers and stores null', async (_label, extra) => {
    const email = `aud-${_label.replace(/\W/g, '')}@example.com`;
    const { res, supabase } = await register({ ...base, email, ...extra });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const row = supabase._state.licenses.find((l) => l.email === email);
    expect(row).toMatchObject({ auditor_finding: null, signup_source_auditor: false, signup_plugin: 'alt_text' });
  });

  test('registration succeeds when the attribution columns are missing (migration not applied)', async () => {
    const supabase = createSupabaseMock();
    const origFrom = supabase.from.bind(supabase);
    supabase.from = (table) => {
      const t = origFrom(table);
      if (table !== 'licenses') return t;
      return { ...t, update: (patch) => ('auditor_finding' in patch
        ? { eq: async () => ({ data: null, error: { code: '42703', message: 'column "auditor_finding" does not exist' } }) }
        : t.update(patch)) };
    };
    const { res } = await register({ ...base, email: 'aud-nomig@example.com', finding: 'missing_alt' }, supabase);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});

describe('register signup_source ("How did you find us?")', () => {
  const { identifyServerUser } = require('../../lib/posthog');
  const register = (app, extra = {}) => request(app)
    .post('/auth/register')
    .send({ email: `u${Math.random().toString(36).slice(2)}@example.com`, password: 'Password123!', ...extra });

  beforeEach(() => identifyServerUser.mockClear());

  test('old plugin (no fields at all) registers exactly as before', async () => {
    const supabase = createSupabaseMock();
    const res = await register(createApp(supabase));
    expect(res.body.success).toBe(true);
    expect('signup_source' in supabase._state.licenses[0]).toBe(false);
    expect(identifyServerUser).not.toHaveBeenCalled();
  });

  test.each(['wporg', 'search', 'x', 'facebook_group', 'friend'])('new code %s is accepted', async (code) => {
    const supabase = createSupabaseMock();
    await register(createApp(supabase), { signup_source: code });
    expect(supabase._state.licenses[0].signup_source).toBe(code);
  });

  test.each([
    ['wporg_search', 'wporg', null],
    ['google', 'search', null],
    ['friend_colleague', 'friend', null],
    ['ai_assistant', 'other', 'ai_assistant'],
    ['oppti_site', 'other', 'oppti_site'],
    ['social', 'other', 'social']
  ])('old code %s is stored as %s', async (oldCode, newCode, otherText) => {
    const supabase = createSupabaseMock();
    const res = await register(createApp(supabase), { signup_source: oldCode });
    expect(res.body.success).toBe(true);
    expect(supabase._state.licenses[0].signup_source).toBe(newCode);
    expect(supabase._state.licenses[0].signup_source_other).toBe(otherText);
  });

  test('sign-up still succeeds when the signup_source columns do not exist yet', async () => {
    const supabase = createSupabaseMock();
    const realFrom = supabase.from.bind(supabase);
    supabase.from = (table) => {
      const api = realFrom(table);
      if (table !== 'licenses') return api;
      return { ...api, update(patch) {
        if ('signup_source' in patch) {
          return { eq: () => Promise.resolve({ data: null, error: { code: '42703', message: 'column "signup_source" does not exist' } }) };
        }
        return api.update(patch);
      } };
    };
    const res = await register(createApp(supabase), { signup_source: 'google' });
    expect(res.body.success).toBe(true);
    expect(res.body.token).toBeTruthy();
  });

  test('blank answer stores nothing and skips PostHog', async () => {
    const supabase = createSupabaseMock();
    const res = await register(createApp(supabase), { signup_source: '', signup_source_other: 'ignored' });
    expect(res.body.success).toBe(true);
    const row = supabase._state.licenses[0];
    expect(row.signup_source).toBeUndefined();
    expect(row.signup_source_other).toBeUndefined();
    expect(identifyServerUser).not.toHaveBeenCalled();
  });

  test('valid answer is stored on the license row and sent as PostHog person properties', async () => {
    const supabase = createSupabaseMock();
    const res = await register(createApp(supabase), { signup_source: 'wporg', signup_source_other: 'drop me', plugin_id: 'alt_text' });
    expect(res.body.success).toBe(true);
    const row = supabase._state.licenses[0];
    expect(row.signup_source).toBe('wporg');
    expect(row.signup_source_other).toBeNull();
    expect(identifyServerUser).toHaveBeenCalledWith({
      distinctId: row.id,
      properties: { $set: { signup_source: 'wporg', signup_source_plugin: 'alt_text' } }
    });
  });

  test('unknown value is ignored and sign-up still succeeds', async () => {
    const supabase = createSupabaseMock();
    const res = await register(createApp(supabase), { signup_source: 'tiktok-ads' });
    expect(res.body.success).toBe(true);
    expect(supabase._state.licenses[0].signup_source).toBeUndefined();
    expect(identifyServerUser).not.toHaveBeenCalled();
  });

  test('non-string value is ignored and sign-up still succeeds', async () => {
    const supabase = createSupabaseMock();
    const res = await register(createApp(supabase), { signup_source: { evil: true } });
    expect(res.body.success).toBe(true);
    expect(supabase._state.licenses[0].signup_source).toBeUndefined();
  });

  test('"other" keeps free text, stripped of tags and capped at 200 chars', async () => {
    const supabase = createSupabaseMock();
    const long = `<b>Podcast</b> <script>x</script>${'a'.repeat(300)}`;
    const res = await register(createApp(supabase), { signup_source: 'other', signup_source_other: long });
    expect(res.body.success).toBe(true);
    const row = supabase._state.licenses[0];
    expect(row.signup_source).toBe('other');
    expect(row.signup_source_other).not.toMatch(/[<>]/);
    expect(row.signup_source_other.startsWith('Podcast')).toBe(true);
    expect(row.signup_source_other.length).toBeLessThanOrEqual(200);
    // The free text stays in the database; PostHog gets the source only.
    expect(identifyServerUser).toHaveBeenCalledWith(expect.objectContaining({
      properties: { $set: expect.objectContaining({ signup_source: 'other' }) }
    }));
    expect(JSON.stringify(identifyServerUser.mock.calls)).not.toMatch(/Podcast|signup_source_other/);
  });
});

describe('register product_emails_opt_out ("Don\'t send me product tips and plan emails")', () => {
  const { trackAccountCreated } = require('../../../src/services/loops');
  const originalKey = process.env.LOOPS_API_KEY;
  const register = (app, extra = {}) => request(app)
    .post('/auth/register')
    .send({ email: `u${Math.random().toString(36).slice(2)}@example.com`, password: 'Password123!', ...extra });

  beforeEach(() => {
    process.env.LOOPS_API_KEY = 'test-key';
    trackAccountCreated.mockClear();
  });
  afterAll(() => {
    if (originalKey === undefined) delete process.env.LOOPS_API_KEY;
    else process.env.LOOPS_API_KEY = originalKey;
  });

  test('ticked box is stored on the account and passed to Loops', async () => {
    const supabase = createSupabaseMock();
    const res = await register(createApp(supabase), { product_emails_opt_out: '1' });
    expect(res.body.success).toBe(true);
    expect(supabase._state.licenses[0].product_emails_opt_out).toBe(true);
    expect(trackAccountCreated).toHaveBeenCalledWith(expect.objectContaining({ productEmailsOptOut: true }));
  });

  test('unticked box is stored as false and Loops is told not opted out', async () => {
    const supabase = createSupabaseMock();
    await register(createApp(supabase), { product_emails_opt_out: false });
    expect(supabase._state.licenses[0].product_emails_opt_out).toBe(false);
    expect(trackAccountCreated).toHaveBeenCalledWith(expect.objectContaining({ productEmailsOptOut: false }));
  });

  test('old plugin (field absent) stores nothing', async () => {
    const supabase = createSupabaseMock();
    const res = await register(createApp(supabase));
    expect(res.body.success).toBe(true);
    expect('product_emails_opt_out' in supabase._state.licenses[0]).toBe(false);
    expect(trackAccountCreated).toHaveBeenCalledWith(expect.objectContaining({ productEmailsOptOut: false }));
  });

  test('sign-up succeeds and still honours the choice in Loops when the column does not exist yet', async () => {
    const supabase = createSupabaseMock();
    const realFrom = supabase.from.bind(supabase);
    supabase.from = (table) => {
      const api = realFrom(table);
      if (table !== 'licenses') return api;
      return { ...api, update(patch) {
        if ('product_emails_opt_out' in patch) {
          return { eq: () => Promise.resolve({ data: null, error: { code: '42703', message: 'column "product_emails_opt_out" does not exist' } }) };
        }
        return api.update(patch);
      } };
    };
    const res = await register(createApp(supabase), { product_emails_opt_out: true });
    expect(res.body.success).toBe(true);
    expect(res.body.token).toBeTruthy();
    expect(trackAccountCreated).toHaveBeenCalledWith(expect.objectContaining({ productEmailsOptOut: true }));
  });
});
