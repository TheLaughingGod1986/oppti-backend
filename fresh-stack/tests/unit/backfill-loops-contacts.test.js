describe('Loops contact backfill', () => {
  const originalEnv = process.env;
  const originalArgv = process.argv;

  beforeEach(() => {
    jest.resetModules();
    process.env = {
      ...originalEnv,
      SUPABASE_URL: 'https://example.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'test-service-key',
      LOOPS_API_KEY: 'test-loops-key',
      LOOPS_PLUGIN_USERS_LIST_ID: 'list123'
    };
    process.argv = ['node', 'backfill-loops-contacts.js'];
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(process, 'exit').mockImplementation(() => {});
  });

  afterEach(() => {
    process.env = originalEnv;
    process.argv = originalArgv;
    jest.restoreAllMocks();
    jest.dontMock('dotenv');
    jest.dontMock('@supabase/supabase-js');
  });

  async function runBackfill() {
    const firstSeenAt = '2026-06-01T00:00:00.000Z';
    const usageRows = ['title_meta', 'internal_linking', 'alt_text'].map((featureType, index) => ({
      license_id: 'account-1',
      feature_type: featureType,
      plugin_version: '1.0.0',
      created_at: `2026-06-0${index + 1}T00:00:00.000Z`
    }));
    const accounts = [{ id: 'account-1', email: 'user@example.com', plan: 'pro', created_at: firstSeenAt }];
    const connectionUpsert = jest.fn().mockResolvedValue({ error: null });
    const client = {
      from: jest.fn((table) => {
        if (table === 'account_plugin_connections') return { upsert: connectionUpsert };
        const chain = {
          select: () => chain,
          not: () => chain,
          eq: () => chain,
          in: () => chain,
          order: () => Promise.resolve({ data: table === 'licenses' ? accounts : usageRows, error: null })
        };
        return chain;
      })
    };
    jest.doMock('dotenv', () => ({ config: jest.fn() }));
    jest.doMock('@supabase/supabase-js', () => ({ createClient: jest.fn(() => client) }));
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: jest.fn().mockResolvedValue({ success: true })
    });
    try {
      require('../../../scripts/backfill-loops-contacts');
      await new Promise((resolve) => setImmediate(resolve));
      expect(console.error).not.toHaveBeenCalled();
      expect(process.exit).not.toHaveBeenCalled();
      return {
        connectionUpsert,
        requests: global.fetch.mock.calls.map(([url, options]) => ({ url, body: JSON.parse(options.body) }))
      };
    } finally {
      delete global.fetch;
    }
  }

  test('defaults to dry-run without contact or connection writes', async () => {
    const { connectionUpsert, requests } = await runBackfill();
    expect(connectionUpsert).not.toHaveBeenCalled();
    expect(requests).toEqual([]);
  });

  test('writes all three memberships without acquisition state or onboarding events', async () => {
    process.argv.push('--write');
    const { connectionUpsert, requests } = await runBackfill();
    expect(connectionUpsert).toHaveBeenCalledTimes(3);
    expect(requests).toHaveLength(3);
    expect(requests.map(({ body }) => body.lastActivePluginId)).toEqual(['titles', 'internal_linking', 'alt_text']);
    for (const { url, body } of requests) {
      expect(url).toMatch(/\/contacts\/update$/);
      expect(body).not.toHaveProperty('source');
      expect(body).not.toHaveProperty('userGroup');
      expect(body).toEqual(expect.objectContaining({
        acquisitionPluginId: 'titles',
        acquisitionPluginTitle: 'BeepBeep Titles',
        plan: 'pro'
      }));
    }
    const internalLinking = requests[1].body;
    expect(internalLinking.internalLinkingFirstSeenAt).toBe('2026-06-02T00:00:00.000Z');
    expect(internalLinking.usesInternalLinking).toBe(true);
    expect(Object.keys(internalLinking).some((key) => key.startsWith('titles') || key.startsWith('altText'))).toBe(false);
  });
});
