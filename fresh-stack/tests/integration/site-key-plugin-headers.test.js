/**
 * Chief's ruling: only data routes need an account credential. A site-key-only
 * caller using the real header sets of Alt Text 4.6.143, Titles 1.0.30 and IL
 * 0.1.4 still authenticates on generation, credit-spend and image-state sync
 * paths, and a fresh guest/trial site still gets its first generation. Data
 * routes (/me/sites, /me/licenses, /license/sites, /usage/users, /usage/sites)
 * refuse site headers alone and still work with the licence key.
 *
 * Header sets (plugin source):
 * - Alt Text 4.6.143 includes/class-api-client-v2.php:524-547 (X-License-Key and
 *   Authorization only when stored), trial headers :2747-2749.
 * - Titles 1.0.30 includes/Api/Client.php:449-471 (always sends X-License-Key,
 *   empty when none; request() refuses without a licence, :479).
 * - IL 0.1.4 includes/rest-api.php:266-287.
 */
const express = require('express');
const request = require('supertest');
const fs = require('fs');
const path = require('path');

const RAW = 'qa-raw-site-key-plugin-hdr-0001';
const INSTALL = 'qa-install-hash-plugin-hdr-0001';
const LICENCE = 'QA-FAKE-LICENSE-KEY-HDR-0001';
const LICENCE_ROW = { id: 'acct-hdr-1', license_key: LICENCE, plan: 'pro', status: 'active', email: 'hdr@example.invalid' };

function supabaseMock() {
  const chain = (table) => {
    const filters = {};
    const c = {
      select: () => c,
      eq: (column, value) => { filters[column] = value; return c; },
      in: () => c, order: () => c, limit: () => c, gte: () => c, lte: () => c, lt: () => c, is: () => c, neq: () => c,
      maybeSingle: async () => {
        if (table === 'sites' && filters.site_hash === RAW) {
          return { data: { license_key: LICENCE, status: 'active', site_hash: RAW }, error: null };
        }
        return { data: null, error: null };
      },
      single: async () => {
        if (table === 'licenses' && filters.license_key === LICENCE) return { data: LICENCE_ROW, error: null };
        return { data: null, error: { code: 'PGRST116', details: 'The result contains 0 rows' } };
      },
      then: (resolve) => resolve({ data: [], error: null })
    };
    return c;
  };
  return { from: chain };
}

const plugins = {
  'alt-text-4.6.143': () => ({
    'Content-Type': 'application/json',
    'X-Site-Hash': RAW,
    'X-Site-Key': RAW,
    'X-Site-URL': 'https://alt.example.com',
    'X-Site-Fingerprint': 'fp-alt',
    'X-WP-User-ID': '1'
  }),
  'titles-1.0.30': () => ({
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'X-License-Key': '',
    'X-Site-Hash': RAW,
    'X-Site-Key': RAW,
    'X-Site-URL': 'https://titles.example.com',
    'X-Install-Hash': INSTALL,
    'X-Site-Fingerprint': 'fp-titles',
    'X-Plugin-Version': '1.0.30',
    'X-Plugin-ID': 'titles',
    'X-Request-Source': 'default'
  }),
  'internal-linking-0.1.4': () => ({
    'Content-Type': 'application/json',
    'X-License-Key': '',
    'X-Site-Hash': RAW,
    'X-Site-Key': RAW,
    'X-Site-URL': 'https://il.example.com',
    'X-Install-Hash': INSTALL,
    'X-Install-UUID': INSTALL,
    'X-Site-Fingerprint': 'fp-il',
    'X-Plugin': 'internal_linking',
    'X-Plugin-ID': 'internal_linking',
    'X-Plugin-Version': '0.1.4'
  })
};

const GENERATION_PATHS = [
  ['post', '/api/alt-text'],
  ['post', '/api/titles/generate'],
  ['post', '/api/internal-linking/suggest'],
  ['post', '/api/jobs'],
  ['post', '/dashboard/image-states/sync']
];

function appWithRouters() {
  const { authMiddleware } = require('../../middleware/auth');
  const { createLicenseRouter } = require('../../routes/license');
  const { createUsageRouter } = require('../../routes/usage');
  const { createAccountDashboardRouter } = require('../../routes/accountDashboard');
  const supabase = supabaseMock();
  const app = express();
  app.use(express.json());
  app.use(authMiddleware({ supabase }));
  // Generation / sync stand-ins: they record who got through the real auth.
  for (const [method, p] of GENERATION_PATHS) {
    app[method](p, (req, res) => res.json({ ok: true, auth_method: req.authMethod, account_id: req.license?.id || null }));
  }
  const service = {
    getSites: async () => [{ id: 's1' }],
    getLicenses: async () => [{ id: 'l1' }]
  };
  app.use(createAccountDashboardRouter({ supabase, service }));
  app.use('/api/license', createLicenseRouter({ supabase }));
  app.use('/api/usage', createUsageRouter({ supabase }));
  return app;
}

function send(app, method, p, headers, body = {}) {
  let r = request(app)[method](p);
  for (const [k, v] of Object.entries(headers)) r = r.set(k, v);
  return method === 'get' ? r : r.send(body);
}

describe('site-key-only plugin callers keep generation and sync', () => {
  test.each(Object.keys(plugins).flatMap((name) => GENERATION_PATHS.map(([m, p]) => [name, m, p])))(
    '%s %s %s authenticates on the site key',
    async (name, method, p) => {
      const res = await send(appWithRouters(), method, p, plugins[name](), { image: { url: 'https://x.example/a.jpg' } });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true, auth_method: 'site', account_id: LICENCE_ROW.id });
    }
  );

  test('a fresh guest/trial site (no site row, no licence) still gets its first generation', async () => {
    const res = await send(appWithRouters(), 'post', '/api/alt-text', {
      'Content-Type': 'application/json',
      'X-Site-Hash': 'qa-fresh-trial-site-0001',
      'X-Site-Key': 'qa-fresh-trial-site-0001',
      'X-Site-URL': 'https://fresh.example.com',
      'X-Trial-Mode': 'true',
      'X-Trial-Site-Hash': 'qa-fresh-trial-site-0001',
      'X-Trial-Remaining': '5'
    }, { image: { url: 'https://x.example/a.jpg' } });
    expect(res.status).toBe(200);
    expect(res.body.auth_method).toBe('trial');
  });

  test('generation, credit-spend and sync routers carry no account-credential gate', () => {
    for (const file of ['altText.js', 'titles.js', 'internalLinking.js', 'jobs.js', 'dashboard.js']) {
      const source = fs.readFileSync(path.resolve(__dirname, '../../routes', file), 'utf8');
      expect(source).not.toMatch(/requireAccountCredential|hasAccountCredential/);
    }
  });
});

describe('data routes need an account credential', () => {
  const DATA_PATHS = ['/me/sites', '/me/licenses', '/api/license/sites', '/api/usage/users', '/api/usage/sites'];

  test.each(Object.keys(plugins).flatMap((name) => DATA_PATHS.map((p) => [name, p])))(
    '%s site headers alone on GET %s get the sign-in reply with no licence or site key',
    async (name, p) => {
      const res = await send(appWithRouters(), 'get', p, plugins[name]());
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ code: 'SIGN_IN_REQUIRED', message: 'Sign in to manage billing.' });
      const body = JSON.stringify(res.body);
      expect(body).not.toContain(LICENCE);
      expect(body).not.toContain(RAW);
    }
  );

  test.each(['/me/sites', '/me/licenses', '/api/license/sites', '/api/usage/users'])(
    'the licence key still works on GET %s', async (p) => {
      const res = await send(appWithRouters(), 'get', p, { ...plugins['alt-text-4.6.143'](), 'X-License-Key': LICENCE });
      expect(res.status).toBe(200);
      // /usage/users's site_install_id body is on the analytics privacy branch
      // (usage-route.test.js there); the merged tree checks it.
      if (p !== '/api/usage/users') expect(JSON.stringify(res.body)).not.toContain(RAW);
    }
  );
});
