describe('Loops multi-plugin integration', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = {
      ...originalEnv,
      LOOPS_API_KEY: 'test-key',
      LOOPS_PLUGIN_USERS_LIST_ID: 'list123'
    };
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: jest.fn().mockResolvedValue({ success: true })
    });
  });

  afterEach(() => {
    process.env = originalEnv;
    delete global.fetch;
  });

  test('builds stable idempotency keys', () => {
    const { buildIdempotencyKey } = require('../../../src/services/loops');
    expect(buildIdempotencyKey('user-1', 'account_created', 'titles'))
      .toBe(buildIdempotencyKey('user-1', 'account_created', 'titles'));
    expect(buildIdempotencyKey('user-1', 'account_created', 'titles'))
      .not.toBe(buildIdempotencyKey('user-1', 'account_created', 'alt_text'));
  });

  test('updates only the current plugin membership flag', async () => {
    const { upsertPluginContact } = require('../../../src/services/loops');
    await upsertPluginContact({
      email: 'user@example.com',
      userId: 'account-1',
      pluginId: 'titles',
      pluginVersion: '1.0.0',
      timestamp: '2026-06-22T10:00:00.000Z'
    });

    const [, options] = global.fetch.mock.calls[0];
    const payload = JSON.parse(options.body);
    expect(payload).toEqual(expect.objectContaining({
      email: 'user@example.com',
      userId: 'account-1',
      usesTitles: true,
      titlesPluginVersion: '1.0.0',
      lastActivePluginId: 'titles',
      mailingLists: { list123: true }
    }));
    expect(payload).not.toHaveProperty('usesAltText');
  });

  test('sends plugin-aware events with an idempotency header', async () => {
    const { sendEvent } = require('../../../src/services/loops');
    await sendEvent('generation_completed', {
      email: 'user@example.com',
      userId: 'account-1',
      pluginId: 'alt_text',
      pluginVersion: '4.6.55',
      idempotencyParts: [5],
      generationsCount: 5
    });

    const [, options] = global.fetch.mock.calls[0];
    expect(options.headers['Idempotency-Key']).toMatch(/^bbai-[a-f0-9]{64}$/);
    expect(JSON.parse(options.body)).toEqual(expect.objectContaining({
      eventName: 'generation_completed',
      eventProperties: expect.objectContaining({
        pluginId: 'alt_text',
        pluginVersion: '4.6.55',
        generationsCount: 5
      })
    }));
  });
});
