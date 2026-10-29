const { normalizeProductEmailsOptOut } = require('../../lib/productEmailOptOut');

describe('normalizeProductEmailsOptOut', () => {
  test.each([
    [true, true], ['1', true], ['true', true], ['on', true], ['yes', true], [1, true],
    [false, false], ['0', false], ['false', false], ['', false], [0, false]
  ])('%p -> %p', (value, expected) => {
    expect(normalizeProductEmailsOptOut({ product_emails_opt_out: value })).toBe(expected);
  });

  test.each([[undefined], [null], [{ a: 1 }], ['maybe'], [2]])('%p -> null (not stored)', (value) => {
    expect(normalizeProductEmailsOptOut({ product_emails_opt_out: value })).toBeNull();
  });

  test('missing body is safe', () => {
    expect(normalizeProductEmailsOptOut()).toBeNull();
    expect(normalizeProductEmailsOptOut(null)).toBeNull();
  });
});

describe('Loops honours the sign-up product email opt-out', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv, LOOPS_API_KEY: 'test-key', LOOPS_PLUGIN_USERS_LIST_ID: 'list123' };
    delete process.env.LOOPS_SKIP_DOMAINS;
    global.fetch = jest.fn().mockImplementation(async (url) => ({
      ok: true,
      status: 200,
      json: jest.fn().mockResolvedValue(String(url).includes('/contacts/find') ? [] : { success: true })
    }));
  });

  afterEach(() => {
    process.env = originalEnv;
    delete global.fetch;
  });

  const bodies = (suffix) => global.fetch.mock.calls
    .filter(([url]) => String(url).includes(suffix))
    .map(([, options]) => JSON.parse(options.body));

  test('opted-out sign-up creates the contact with subscribed=false, no list and no events', async () => {
    const { trackAccountCreated } = require('../../../src/services/loops');
    await trackAccountCreated({ email: 'user@example.com', userId: 'acc-1', pluginId: 'alt_text', productEmailsOptOut: true });
    const updates = bodies('/contacts/update');
    expect(updates).toHaveLength(1);
    expect(updates[0]).toEqual(expect.objectContaining({ email: 'user@example.com', subscribed: false }));
    expect(updates[0]).not.toHaveProperty('mailingLists');
    expect(bodies('/events/send')).toHaveLength(0);
  });

  test('default sign-up is unchanged: list membership, no subscribed field, both events', async () => {
    const { trackAccountCreated } = require('../../../src/services/loops');
    await trackAccountCreated({ email: 'user@example.com', userId: 'acc-1', pluginId: 'alt_text' });
    const updates = bodies('/contacts/update');
    expect(updates[0]).toEqual(expect.objectContaining({ mailingLists: { list123: true } }));
    expect(updates[0]).not.toHaveProperty('subscribed');
    expect(bodies('/events/send').map((b) => b.eventName)).toEqual(['account_created', 'plugin_connected']);
  });

  test('opted-out login does not send plugin_connected or re-add the list', async () => {
    const { trackPluginConnected } = require('../../../src/services/loops');
    await trackPluginConnected({ email: 'user@example.com', userId: 'acc-1', pluginId: 'titles', productEmailsOptOut: true });
    expect(bodies('/events/send')).toHaveLength(0);
    expect(bodies('/contacts/update')[0]).not.toHaveProperty('mailingLists');
  });

  function supabaseFor(license, { missingColumn = false } = {}) {
    const from = (table) => {
      const state = { table, columns: '' };
      const result = () => {
        if (table === 'licenses') {
          if (missingColumn && state.columns.includes('product_emails_opt_out')) {
            return { data: null, error: { code: '42703', message: 'column licenses.product_emails_opt_out does not exist' } };
          }
          return { data: license, error: null };
        }
        if (table === 'usage_logs') return { data: Array.from({ length: 5 }, () => ({ credits_used: 1, feature_type: 'alt_text' })), error: null };
        if (table === 'sites') return { data: [{ id: 'site-1' }], error: null };
        if (table === 'site_subscriptions') return { data: [], error: null };
        if (table === 'site_quotas') return { data: [{ remaining_credits: 0, purchased_credits_balance: 0, bonus_credits_balance: 0 }], error: null };
        return { data: null, error: null };
      };
      const b = {
        select(cols) { state.columns = cols || ''; return b; },
        eq() { return b; }, in() { return b; }, gte() { return b; }, lte() { return b; }, gt() { return b; },
        order() { return b; }, limit() { return b; },
        single() { return Promise.resolve(result()); },
        then(ok, ko) { return Promise.resolve(result()).then(ok, ko); }
      };
      return b;
    };
    return { from };
  }
  const baseLicense = { plan: 'free', status: 'active', stripe_subscription_id: null, billing_day_of_month: 1 };
  const args = { licenseKey: 'lk', licenseId: 'acc-1', siteHash: 'h', userEmail: 'user@example.com', featureType: 'alt_text' };

  test('opted-out account gets no generation_completed or credits_exhausted', async () => {
    const { trackLoopsAfterGeneration } = require('../../services/usage');
    const result = await trackLoopsAfterGeneration(supabaseFor({ ...baseLicense, product_emails_opt_out: true }), args);
    expect(result.reason).toBe('product_emails_opt_out');
    expect(global.fetch).toHaveBeenCalledTimes(0);
  });

  test('before the migration runs, product events still flow (nobody has opted out)', async () => {
    const { trackLoopsAfterGeneration } = require('../../services/usage');
    const result = await trackLoopsAfterGeneration(supabaseFor(baseLicense, { missingColumn: true }), args);
    expect(result.creditsExhausted).toBe(true);
    expect(bodies('/events/send').map((b) => b.eventName)).toEqual(['generation_completed', 'credits_exhausted']);
  });
});
