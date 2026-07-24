const {
  createAccountDashboardService,
  aggregatePluginStats
} = require('../../services/accountDashboard');

function createThenable(result) {
  const builder = {
    select: jest.fn(() => builder),
    or: jest.fn(() => builder),
    eq: jest.fn(() => builder),
    in: jest.fn(() => builder),
    gte: jest.fn(() => builder),
    lt: jest.fn(() => builder),
    order: jest.fn(() => builder),
    limit: jest.fn(() => builder),
    maybeSingle: jest.fn(async () => result),
    single: jest.fn(async () => result),
    then: (resolve, reject) => Promise.resolve(result).then(resolve, reject)
  };
  return builder;
}

describe('account dashboard usage aggregation', () => {
  test('aggregatePluginStats groups credits across plugins', () => {
    const stats = aggregatePluginStats([
      { feature_type: 'alt_text', credits_used: 1 },
      { feature_type: 'alt_text', credits_used: 1 },
      { feature_type: 'title_meta', credits_used: 2 }
    ]);

    expect(stats).toEqual(expect.arrayContaining([
      expect.objectContaining({
        plugin_name: 'OpptiAI Alt Text',
        credits_used: 2,
        images_processed: 2,
        alt_text_generated: 2
      }),
      expect.objectContaining({
        plugin_name: 'OpptiAI Titles',
        credits_used: 2,
        images_processed: 1,
        meta_tags_generated: 1
      })
    ]));
  });

  test('getDashboard aggregates usage across license and site hashes', async () => {
    const usageRows = [
      { id: '1', feature_type: 'alt_text', credits_used: 1, site_hash: 'site-a', license_key: 'lic-1' },
      { id: '2', feature_type: 'alt_text', credits_used: 1, site_hash: 'site-b', license_key: null },
      { id: '3', feature_type: 'title_meta', credits_used: 2, site_hash: 'site-a', license_id: 'acct-1' }
    ];

    const supabase = {
      from: jest.fn((table) => {
        if (table === 'usage_logs') {
          return createThenable({ data: usageRows, error: null });
        }
        if (table === 'site_subscriptions') {
          return createThenable({ data: [], error: null });
        }
        if (table === 'sites') {
          return createThenable({
            data: [
              { id: 's1', site_hash: 'site-a', site_url: 'https://a.example', license_key: 'lic-1', status: 'active' },
              { id: 's2', site_hash: 'site-b', site_url: 'https://b.example', license_key: 'lic-1', status: 'active' }
            ],
            error: null
          });
        }
        return createThenable({ data: [], error: null });
      })
    };

    // getSites is used via require('./site'); stub through membership-style return
    // by making supabase sites query return membership path empty then license path.
    const service = createAccountDashboardService({
      supabase,
      getStripe: jest.fn()
    });

    // Monkey-patch listRawSites indirectly: getSites uses site_memberships first.
    // Provide empty memberships then sites-by-license.
    supabase.from = jest.fn((table) => {
      if (table === 'site_memberships') {
        return createThenable({ data: [], error: null });
      }
      if (table === 'usage_logs') {
        return createThenable({ data: usageRows, error: null });
      }
      if (table === 'site_subscriptions') {
        return createThenable({ data: [], error: null });
      }
      if (table === 'sites') {
        return createThenable({
          data: [
            { id: 's1', site_hash: 'site-a', site_url: 'https://a.example', license_key: 'lic-1', status: 'active' },
            { id: 's2', site_hash: 'site-b', site_url: 'https://b.example', license_key: 'lic-1', status: 'active' }
          ],
          error: null
        });
      }
      if (table === 'licenses') {
        return createThenable({
          data: {
            id: 'acct-1',
            license_key: 'lic-1',
            plan: 'pro',
            status: 'active',
            billing_day_of_month: 1
          },
          error: null
        });
      }
      return createThenable({ data: [], error: null });
    });

    const dashboard = await service.getDashboard({
      user: {
        id: 'acct-1',
        license_key: 'lic-1',
        plan: 'pro',
        status: 'active',
        billing_day_of_month: 1
      }
    });

    expect(dashboard.usage.credits_used).toBe(4);
    expect(dashboard.usage.credits_included).toBe(1000);
    expect(dashboard.usage.images_optimized).toBe(3);
    expect(dashboard.subscription.plan_name).toBe('Pro');
  });

  test('getInvoices returns an empty list when Stripe is unavailable', async () => {
    const service = createAccountDashboardService({
      supabase: { from: jest.fn() },
      getStripe: () => null
    });

    await expect(service.getInvoices({
      user: { id: 'acct-1', stripe_customer_id: 'cus_123', plan: 'pro' }
    })).resolves.toEqual([]);

    await expect(service.getInvoices({
      user: { id: 'acct-1', stripe_customer_id: null, plan: 'free' }
    })).resolves.toEqual([]);
  });

  test('getPluginStats returns per-plugin rows for account-wide usage', async () => {
    const usageRows = [
      { id: '1', feature_type: 'alt_text', credits_used: 1, site_hash: 'site-a' },
      { id: '2', feature_type: 'title_meta', credits_used: 2, site_hash: 'site-b' }
    ];

    const supabase = {
      from: jest.fn((table) => {
        if (table === 'site_memberships') {
          return createThenable({ data: [], error: null });
        }
        if (table === 'usage_logs') {
          return createThenable({ data: usageRows, error: null });
        }
        if (table === 'sites') {
          return createThenable({
            data: [
              { id: 's1', site_hash: 'site-a', site_url: 'https://a.example', license_key: 'lic-1', status: 'active' },
              { id: 's2', site_hash: 'site-b', site_url: 'https://b.example', license_key: 'lic-1', status: 'active' }
            ],
            error: null
          });
        }
        return createThenable({ data: [], error: null });
      })
    };

    const service = createAccountDashboardService({
      supabase,
      getStripe: jest.fn()
    });

    const stats = await service.getPluginStats({
      user: {
        id: 'acct-1',
        license_key: 'lic-1',
        plan: 'free',
        status: 'active',
        billing_day_of_month: 1
      }
    });

    expect(stats).toHaveLength(2);
    expect(stats.find((row) => row.plugin_name === 'OpptiAI Alt Text')?.credits_used).toBe(1);
    expect(stats.find((row) => row.plugin_name === 'OpptiAI Titles')?.credits_used).toBe(2);
  });
});
