/**
 * credits_exhausted must only reach Loops when a site has genuinely run out
 * (site wallet at zero, no active/trialing/past_due site subscription), and
 * must carry the real plan plus paywall contact properties.
 */

const LICENSE_KEY = '11111111-2222-4333-8444-555555555555';
const LICENSE_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const SITE_HASH = 'site-hash-1';
const SITE_ID = 'site-1';

function makeSupabase(tables) {
  const calls = [];
  const from = (table) => {
    const state = { table, op: 'select', filters: [] };
    const resolve = () => {
      const handler = tables[table];
      if (!handler) return { data: null, error: null };
      return handler(state);
    };
    const builder = {
      select() { return builder; },
      insert(payload) { state.op = 'insert'; state.payload = payload; return builder; },
      update(payload) { state.op = 'update'; state.payload = payload; return builder; },
      eq(col, val) { state.filters.push(['eq', col, val]); return builder; },
      in(col, val) { state.filters.push(['in', col, val]); return builder; },
      gte(col, val) { state.filters.push(['gte', col, val]); return builder; },
      lte(col, val) { state.filters.push(['lte', col, val]); return builder; },
      gt(col, val) { state.filters.push(['gt', col, val]); return builder; },
      order() { return builder; },
      limit() { return builder; },
      single() { return Promise.resolve(resolve()); },
      maybeSingle() { return Promise.resolve(resolve()); },
      then(onFulfilled, onRejected) { return Promise.resolve(resolve()).then(onFulfilled, onRejected); }
    };
    calls.push(state);
    return builder;
  };
  return { from, calls };
}

function scenario({
  licensePlan = 'free',
  licenseExtra = {},
  usedCredits = 50,
  subscriptions = [],
  quota = { remaining_credits: 0, purchased_credits_balance: 0, bonus_credits_balance: 0 },
  sites = [{ id: SITE_ID }],
  accountSites = null,
  memberships = [],
  failTables = []
} = {}) {
  const fail = (table) => (failTables.includes(table) ? { data: null, error: { message: `${table} unavailable` } } : null);
  return makeSupabase({
    usage_logs: (state) => {
      if (state.op === 'insert') return { data: [{ id: 'log-1' }], error: null };
      return {
        data: Array.from({ length: usedCredits }, () => ({ credits_used: 1, feature_type: 'alt_text' })),
        error: null
      };
    },
    licenses: () => ({
      data: {
        id: LICENSE_ID,
        plan: licensePlan,
        status: 'active',
        stripe_subscription_id: null,
        billing_day_of_month: 1,
        ...licenseExtra
      },
      error: null
    }),
    sites: (state) => {
      const byLicence = state.filters.some(([op, col]) => op === 'eq' && col === 'license_key');
      if (byLicence) return fail('sites') || { data: accountSites || sites, error: null };
      return { data: sites, error: null };
    },
    site_memberships: () => fail('site_memberships') || { data: memberships, error: null },
    site_subscriptions: (state) => {
      const statusFilter = state.filters.find(([op, col]) => op === 'in' && col === 'status');
      const siteEq = state.filters.find(([op, col]) => op === 'eq' && col === 'site_id');
      const siteIn = state.filters.find(([op, col]) => op === 'in' && col === 'site_id');
      let rows = subscriptions.map((r) => ({ site_id: SITE_ID, ...r }));
      if (statusFilter) rows = rows.filter((r) => statusFilter[2].includes(r.status));
      if (siteEq) rows = rows.filter((r) => r.site_id === siteEq[2]);
      if (siteIn) rows = rows.filter((r) => siteIn[2].includes(r.site_id));
      if (siteIn && failTables.includes('site_subscriptions')) return fail('site_subscriptions');
      return { data: rows, error: null };
    },
    site_quotas: () => ({ data: quota ? [quota] : [], error: null })
  });
}

const flush = async () => {
  for (let i = 0; i < 20; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setImmediate(resolve));
  }
};

describe('credits_exhausted paywall guard', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv, LOOPS_API_KEY: 'test-key', LOOPS_PLUGIN_USERS_LIST_ID: 'list123' };
    delete process.env.LOOPS_SKIP_DOMAINS;
    global.fetch = jest.fn().mockImplementation(async () => ({
      ok: true,
      status: 200,
      json: jest.fn().mockResolvedValue({ success: true })
    }));
  });

  afterEach(() => {
    process.env = originalEnv;
    delete global.fetch;
  });

  const loopsBodies = (suffix) => global.fetch.mock.calls
    .filter(([url]) => String(url).includes(suffix))
    .map(([, options]) => ({ body: JSON.parse(options.body), headers: options.headers }));
  const exhaustedEvents = () => loopsBodies('/events/send').filter(({ body }) => body.eventName === 'credits_exhausted');

  async function generate(supabase, { email = 'owner@example.com', featureType = 'alt_text' } = {}) {
    const { recordUsage } = require('../../services/usage');
    await recordUsage(supabase, {
      licenseKey: LICENSE_KEY,
      licenseId: LICENSE_ID,
      siteHash: SITE_HASH,
      userEmail: email,
      featureType
    });
    await flush();
  }

  test('paid site subscription on a free licence gets no credits_exhausted event', async () => {
    await generate(scenario({
      licensePlan: 'free',
      subscriptions: [{ id: 'sub-1', status: 'active', plan_id: 'pro' }]
    }));
    expect(exhaustedEvents()).toHaveLength(0);
  });

  test.each(['trialing', 'past_due'])('%s site subscription also blocks the event', async (status) => {
    await generate(scenario({ subscriptions: [{ id: 'sub-1', status, plan_id: 'starter' }] }));
    expect(exhaustedEvents()).toHaveLength(0);
  });

  test('credit-pack buyer with credits left gets no event even when licence usage exceeds the free limit', async () => {
    await generate(scenario({
      licensePlan: 'credits',
      usedCredits: 500,
      quota: { remaining_credits: 40, purchased_credits_balance: 100, bonus_credits_balance: 0 }
    }));
    expect(exhaustedEvents()).toHaveLength(0);
  });

  test('purchased or bonus balance alone keeps the site off the paywall', async () => {
    await generate(scenario({ quota: { remaining_credits: 0, purchased_credits_balance: 0, bonus_credits_balance: 5 } }));
    expect(exhaustedEvents()).toHaveLength(0);
  });

  test('a free site at zero sends one event with the real plan and paywall contact properties', async () => {
    await generate(scenario({ licensePlan: 'free' }), { featureType: 'title_meta' });

    const events = exhaustedEvents();
    expect(events).toHaveLength(1);
    const { body } = events[0];
    expect(body.email).toBe('owner@example.com');
    expect(body.eventProperties).toEqual(expect.objectContaining({ pluginId: 'titles', plan: 'free' }));
    expect(Number.isNaN(Date.parse(body.eventProperties.paywallHitAt))).toBe(false);

    const contactUpdates = loopsBodies('/contacts/update').map(({ body: b }) => b).filter((b) => 'paywallPluginId' in b);
    expect(contactUpdates).toHaveLength(1);
    expect(contactUpdates[0]).toEqual(expect.objectContaining({
      email: 'owner@example.com',
      paywallPluginId: 'titles',
      plan: 'free'
    }));
    expect(contactUpdates[0].paywallHitAt).toBe(body.eventProperties.paywallHitAt);
    expect(contactUpdates[0]).not.toHaveProperty('mailingLists');
  });

  test('the event carries the licence plan instead of a hard-coded free', async () => {
    await generate(scenario({ licensePlan: 'credits' }));
    const events = exhaustedEvents();
    expect(events).toHaveLength(1);
    expect(events[0].body.eventProperties.plan).toBe('credits');
  });

  test('a legacy paid licence with a Stripe subscription gets no event', async () => {
    await generate(scenario({
      licensePlan: 'pro',
      licenseExtra: { stripe_subscription_id: 'sub_legacy' }
    }));
    expect(exhaustedEvents()).toHaveLength(0);
  });

  test('fails closed when the site or its quota row cannot be found', async () => {
    await generate(scenario({ sites: [] }));
    await generate(scenario({ quota: null }));
    await generate(scenario({ sites: [{ id: 'a' }, { id: 'b' }] }));
    expect(exhaustedEvents()).toHaveLength(0);
  });

  test('throttle: repeat hits in one period share one idempotency key per plugin', async () => {
    await generate(scenario());
    await generate(scenario());
    await generate(scenario(), { featureType: 'title_meta' });
    const keys = exhaustedEvents().map(({ headers }) => headers['Idempotency-Key']);
    expect(keys).toHaveLength(3);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[2]).not.toBe(keys[0]);
  });

  const planWrites = () => loopsBodies('/contacts/update').map(({ body }) => body).filter((b) => 'plan' in b);

  describe('account-wide paying check', () => {
    const SECOND_SITE = 'site-2';

    test('free second site on an account with a paying first site sends nothing and writes no plan', async () => {
      await generate(scenario({
        sites: [{ id: SECOND_SITE }],
        accountSites: [{ id: SITE_ID }, { id: SECOND_SITE }],
        subscriptions: [{ id: 'sub-1', site_id: SITE_ID, status: 'active', plan_id: 'pro' }]
      }));
      expect(exhaustedEvents()).toHaveLength(0);
      expect(planWrites()).toHaveLength(0);
    });

    test.each(['trialing', 'past_due'])('a %s subscription on another site also blocks', async (status) => {
      await generate(scenario({
        sites: [{ id: SECOND_SITE }],
        accountSites: [{ id: SITE_ID }, { id: SECOND_SITE }],
        subscriptions: [{ id: 'sub-1', site_id: SITE_ID, status, plan_id: 'starter' }]
      }));
      expect(exhaustedEvents()).toHaveLength(0);
      expect(planWrites()).toHaveLength(0);
    });

    test('a paying site reached only through site_memberships blocks', async () => {
      await generate(scenario({
        sites: [{ id: SECOND_SITE }],
        accountSites: [{ id: SECOND_SITE }],
        memberships: [{ site_id: SITE_ID }],
        subscriptions: [{ id: 'sub-1', site_id: SITE_ID, status: 'active', plan_id: 'agency' }]
      }));
      expect(exhaustedEvents()).toHaveLength(0);
      expect(planWrites()).toHaveLength(0);
    });

    test('former payers (canceled, incomplete_expired) are not blocked', async () => {
      await generate(scenario({
        sites: [{ id: SECOND_SITE }],
        accountSites: [{ id: SITE_ID }, { id: SECOND_SITE }],
        subscriptions: [
          { id: 'sub-1', site_id: SITE_ID, status: 'canceled', plan_id: 'pro' },
          { id: 'sub-2', site_id: SITE_ID, status: 'incomplete_expired', plan_id: 'pro' }
        ]
      }));
      expect(exhaustedEvents()).toHaveLength(1);
      expect(exhaustedEvents()[0].body.eventProperties.plan).toBe('free');
    });

    test.each(['sites', 'site_memberships', 'site_subscriptions'])(
      'a failed %s account lookup sends nothing (fails closed)',
      async (table) => {
        await generate(scenario({
          sites: [{ id: SECOND_SITE }],
          accountSites: [{ id: SECOND_SITE }],
          failTables: [table]
        }));
        expect(exhaustedEvents()).toHaveLength(0);
        expect(planWrites()).toHaveLength(0);
      }
    );

    test('Internal Linking still sends the event for a free account at zero', async () => {
      await generate(scenario(), { featureType: 'internal_linking' });
      const events = exhaustedEvents();
      expect(events).toHaveLength(1);
      expect(events[0].body.eventProperties).toEqual(expect.objectContaining({ pluginId: 'internal_linking', plan: 'free' }));
    });
  });

  test('LOOPS_SKIP_DOMAINS still suppresses the event and contact update', async () => {
    await generate(scenario(), { email: 'qa@qa.oppti.dev' });
    process.env.LOOPS_SKIP_DOMAINS = 'skipme.test';
    jest.resetModules();
    await generate(scenario(), { email: 'someone@skipme.test' });
    expect(global.fetch).toHaveBeenCalledTimes(0);
  });
});
