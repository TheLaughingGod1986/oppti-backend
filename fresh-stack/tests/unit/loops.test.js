describe('Loops multi-plugin integration', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = {
      ...originalEnv,
      LOOPS_API_KEY: 'test-key',
      LOOPS_PLUGIN_USERS_LIST_ID: 'list123'
    };
    delete process.env.LOOPS_SKIP_DOMAINS;
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

  describe('LOOPS_SKIP_DOMAINS', () => {
    const eventArgs = (email) => ({
      email,
      userId: 'account-1',
      pluginId: 'alt_text',
      pluginVersion: '4.6.55',
      idempotencyParts: [5],
      generationsCount: 5
    });
    const contactArgs = (email) => ({
      email,
      userId: 'account-1',
      pluginId: 'titles',
      pluginVersion: '1.0.0'
    });

    test('default list skips upsert and events for QA domains (case-insensitive)', async () => {
      const { upsertPluginContact, sendEvent, isLoopsSkippedEmail } = require('../../../src/services/loops');
      for (const email of ['qa@Example.INVALID', 'x@maxxspace.com']) {
        expect(isLoopsSkippedEmail(email)).toBe(true);
        await expect(upsertPluginContact(contactArgs(email))).resolves.toBeNull();
        await expect(sendEvent('generation_completed', eventArgs(email))).resolves.toBeNull();
      }
      expect(global.fetch).toHaveBeenCalledTimes(0);
    });

    test('default list covers uberip.com and qa.oppti.dev', () => {
      const { getSkipDomains, isLoopsSkippedEmail } = require('../../../src/services/loops');
      expect(getSkipDomains()).toEqual(['example.invalid', 'maxxspace.com', 'uberip.com', 'qa.oppti.dev']);
      expect(isLoopsSkippedEmail('a@uberip.com')).toBe(true);
      expect(isLoopsSkippedEmail('a@qa.oppti.dev')).toBe(true);
    });

    test('trackAccountCreated sends nothing for a skipped domain', async () => {
      const { trackAccountCreated } = require('../../../src/services/loops');
      await trackAccountCreated({ email: 't@qa.oppti.dev', userId: 'account-1', pluginId: 'alt_text' });
      expect(global.fetch).toHaveBeenCalledTimes(0);
    });

    test('other track helpers send nothing for a skipped domain', async () => {
      const {
        trackPluginConnected,
        trackGenerationMilestone,
        trackCreditsExhausted
      } = require('../../../src/services/loops');
      const base = { email: 'qa@example.invalid', userId: 'account-1', pluginId: 'alt_text' };
      await trackPluginConnected(base);
      await trackGenerationMilestone({ ...base, generationsCount: 5 });
      await trackCreditsExhausted(base);
      expect(global.fetch).toHaveBeenCalledTimes(0);
    });

    test('normal emails still reach Loops', async () => {
      const { upsertPluginContact, sendEvent, trackAccountCreated, isLoopsSkippedEmail } = require('../../../src/services/loops');
      expect(isLoopsSkippedEmail('user@example.com')).toBe(false);
      await upsertPluginContact(contactArgs('user@example.com'));
      await sendEvent('generation_completed', eventArgs('user@example.com'));
      expect(global.fetch).toHaveBeenCalledTimes(2);
      await trackAccountCreated({ email: 'user@example.com', userId: 'account-1', pluginId: 'alt_text' });
      expect(global.fetch).toHaveBeenCalledTimes(5);
    });

    test('missing or invalid emails are never skipped by this rule', () => {
      const { isLoopsSkippedEmail } = require('../../../src/services/loops');
      expect(isLoopsSkippedEmail(undefined)).toBe(false);
      expect(isLoopsSkippedEmail(null)).toBe(false);
      expect(isLoopsSkippedEmail('')).toBe(false);
      expect(isLoopsSkippedEmail('maxxspace.com')).toBe(false);
      expect(isLoopsSkippedEmail('user@')).toBe(false);
    });

    test('custom list replaces the default, exact domain match only', async () => {
      process.env.LOOPS_SKIP_DOMAINS = ' Foo.com , bar.org ';
      const { getSkipDomains, isLoopsSkippedEmail, sendEvent } = require('../../../src/services/loops');
      expect(getSkipDomains()).toEqual(['foo.com', 'bar.org']);
      expect(isLoopsSkippedEmail('a@FOO.com')).toBe(true);
      expect(isLoopsSkippedEmail('a@bar.org')).toBe(true);
      expect(isLoopsSkippedEmail('a@maxxspace.com')).toBe(false);
      expect(isLoopsSkippedEmail('a@sub.foo.com')).toBe(false);

      await sendEvent('generation_completed', eventArgs('a@FOO.com'));
      expect(global.fetch).toHaveBeenCalledTimes(0);
      await sendEvent('generation_completed', eventArgs('a@maxxspace.com'));
      await sendEvent('generation_completed', eventArgs('a@sub.foo.com'));
      expect(global.fetch).toHaveBeenCalledTimes(2);
    });

    test('empty LOOPS_SKIP_DOMAINS skips nothing', async () => {
      process.env.LOOPS_SKIP_DOMAINS = '';
      const { getSkipDomains, isLoopsSkippedEmail, upsertPluginContact } = require('../../../src/services/loops');
      expect(getSkipDomains()).toEqual([]);
      expect(isLoopsSkippedEmail('qa@example.invalid')).toBe(false);
      expect(isLoopsSkippedEmail('x@maxxspace.com')).toBe(false);
      await upsertPluginContact(contactArgs('qa@example.invalid'));
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });
  });
});
