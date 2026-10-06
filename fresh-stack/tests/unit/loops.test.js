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
    // By default the contact lookup finds no existing contact.
    global.fetch = jest.fn().mockImplementation(async (url) => ({
      ok: true,
      status: 200,
      json: jest.fn().mockResolvedValue(String(url).includes('/contacts/find') ? [] : { success: true })
    }));
  });

  const jsonResponse = (status, body) => ({
    ok: status >= 200 && status < 300,
    status,
    json: jest.fn().mockResolvedValue(body)
  });
  const callsTo = (suffix) => global.fetch.mock.calls.filter(([url]) => String(url).includes(suffix));
  const updateBody = () => {
    const updates = callsTo('/contacts/update');
    expect(updates).toHaveLength(1);
    return JSON.parse(updates[0][1].body);
  };
  // Answers the contact lookup with `findResponse` (or rejects with it if it is an Error).
  const mockFind = (findResponse) => {
    global.fetch.mockImplementation(async (url) => {
      if (String(url).includes('/contacts/find')) {
        if (findResponse instanceof Error) throw findResponse;
        return findResponse;
      }
      return jsonResponse(200, { success: true });
    });
  };

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

  test.each([
    ['alt_text', 'alt-text'],
    ['titles', 'titles'],
    ['internal_linking', 'internal-linking']
  ])('account creation for %s sets its origin and free group', async (pluginId, source) => {
    const { trackAccountCreated } = require('../../../src/services/loops');
    await trackAccountCreated({ email: 'user@example.com', userId: 'account-1', pluginId });

    expect(global.fetch.mock.calls[0][0]).toMatch(/\/contacts\/find\?email=user%40example\.com$/);
    expect(global.fetch.mock.calls[0][1].method).toBe('GET');
    expect(global.fetch.mock.calls[0][1]).not.toHaveProperty('body');
    expect(global.fetch.mock.calls[1][0]).toMatch(/\/contacts\/update$/);
    expect(JSON.parse(global.fetch.mock.calls[1][1].body)).toEqual(expect.objectContaining({
      source,
      signupPlugin: pluginId,
      userGroup: 'free',
      acquisitionPluginId: pluginId,
      mailingLists: { list123: true }
    }));
    expect(global.fetch).toHaveBeenCalledTimes(4);
  });

  describe('account creation preserves an existing Loops source', () => {
    const signup = (pluginId = 'titles') => {
      const { trackAccountCreated } = require('../../../src/services/loops');
      return trackAccountCreated({ email: 'lead@example.com', userId: 'account-1', pluginId });
    };
    const expectSignupCompleted = () => {
      const events = callsTo('/events/send').map(([, options]) => JSON.parse(options.body).eventName);
      expect(events).toEqual(['account_created', 'plugin_connected']);
    };

    test.each(['image-seo-audit', 'newsletter', 'API'])(
      'keeps an existing non-empty source (%s)', async (existingSource) => {
        mockFind(jsonResponse(200, [{ id: 'c1', email: 'lead@example.com', source: existingSource }]));
        await signup('titles');

        const body = updateBody();
        expect(body).not.toHaveProperty('source');
        expect(body).toEqual(expect.objectContaining({
          signupPlugin: 'titles',
          userGroup: 'free',
          acquisitionPluginId: 'titles'
        }));
        expectSignupCompleted();
      }
    );

    test.each([
      ['empty string', [{ id: 'c1', source: '' }]],
      ['whitespace', [{ id: 'c1', source: '   ' }]],
      ['null', [{ id: 'c1', source: null }]],
      ['missing', [{ id: 'c1' }]],
      ['no existing contact', []]
    ])('sets the plugin source when the existing source is %s', async (_label, contacts) => {
      mockFind(jsonResponse(200, contacts));
      await signup('internal_linking');

      expect(updateBody()).toEqual(expect.objectContaining({
        source: 'internal-linking',
        signupPlugin: 'internal_linking'
      }));
      expectSignupCompleted();
    });

    test.each([
      ['an HTTP error', jsonResponse(500, { message: 'boom' })],
      ['a rate limit', jsonResponse(429, { message: 'slow down' })],
      ['a network error', new Error('socket hang up')],
      ['an unexpected response shape', jsonResponse(200, { success: true })]
    ])('omits source but still completes signup when the lookup returns %s', async (_label, findResponse) => {
      mockFind(findResponse);
      await expect(signup('alt_text')).resolves.toBeUndefined();

      const body = updateBody();
      expect(body).not.toHaveProperty('source');
      expect(body).toEqual(expect.objectContaining({
        signupPlugin: 'alt_text',
        userGroup: 'free',
        acquisitionPluginId: 'alt_text'
      }));
      expectSignupCompleted();
    });

    test.each([
      ['alt_text', jsonResponse(200, [])],
      ['titles', jsonResponse(200, [{ source: 'image-seo-audit' }])],
      ['internal_linking', jsonResponse(500, {})],
      ['titles', new Error('timeout')]
    ])('always sets signupPlugin to %s on account creation', async (pluginId, findResponse) => {
      mockFind(findResponse);
      await signup(pluginId);
      expect(updateBody().signupPlugin).toBe(pluginId);
    });

    test('non-acquisition updates neither look up the contact nor set signupPlugin', async () => {
      const { trackPluginConnected, upsertPluginContact } = require('../../../src/services/loops');
      await trackPluginConnected({ email: 'user@example.com', userId: 'account-1', pluginId: 'titles' });
      await upsertPluginContact({ email: 'user@example.com', pluginId: 'alt_text', acquisition: false });

      expect(callsTo('/contacts/find')).toHaveLength(0);
      for (const [, options] of callsTo('/contacts/update')) {
        const body = JSON.parse(options.body);
        expect(body).not.toHaveProperty('signupPlugin');
        expect(body).not.toHaveProperty('source');
      }
    });
  });

  test.each(['alt_text', 'titles', 'internal_linking'])(
    'connection and generation updates for %s preserve origin and group', async (pluginId) => {
      const { trackPluginConnected, trackGenerationMilestone } = require('../../../src/services/loops');
      const args = { email: 'user@example.com', userId: 'account-1', pluginId };
      await trackPluginConnected(args);
      await trackGenerationMilestone({ ...args, generationsCount: 5 });

      const updates = global.fetch.mock.calls.filter(([url]) => url.endsWith('/contacts/update'));
      expect(updates).toHaveLength(2);
      for (const [, options] of updates) {
        const body = JSON.parse(options.body);
        expect(body).not.toHaveProperty('source');
        expect(body).not.toHaveProperty('userGroup');
      }
    }
  );

  test.each([true, false])('internal-linking fields remain isolated (acquisition: %s)', async (acquisition) => {
    const { upsertPluginContact } = require('../../../src/services/loops');
    const timestamp = '2026-10-06T12:00:00.000Z';
    await upsertPluginContact({
      email: 'user@example.com',
      pluginId: 'internal_linking',
      pluginVersion: '1.2.3',
      timestamp,
      acquisition
    });

    const body = updateBody();
    expect(body).toEqual(expect.objectContaining({
      usesInternalLinking: true,
      internalLinkingPluginVersion: '1.2.3',
      internalLinkingLastActiveAt: timestamp,
      lastActivePluginId: 'internal_linking',
      lastActivePluginTitle: 'OpptiAI Internal Linking'
    }));
    if (acquisition) {
      expect(body.internalLinkingFirstSeenAt).toBe(timestamp);
    } else {
      expect(body).not.toHaveProperty('internalLinkingFirstSeenAt');
    }
    expect(body).not.toHaveProperty('usesTitles');
    expect(body).not.toHaveProperty('usesAltText');
    expect(Object.keys(body).some((key) => key.startsWith('titles') || key.startsWith('altText'))).toBe(false);
  });

  test.each(['trackPlanUpgraded', 'trackPaymentSucceeded'])('%s marks the contact paid', async (helper) => {
    const loops = require('../../../src/services/loops');
    await loops[helper]({ email: 'user@example.com', planName: 'pro' });

    expect(global.fetch.mock.calls[0][0]).toMatch(/\/contacts\/update$/);
    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body).toEqual(expect.objectContaining({ userGroup: 'paid', plan: 'pro' }));
    expect(body).not.toHaveProperty('source');
  });

  test('trackPlanUpgraded does not mark a downgrade to free as paid', async () => {
    const loops = require('../../../src/services/loops');
    await loops.trackPlanUpgraded({ email: 'user@example.com', planName: 'free' });

    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body.plan).toBe('free');
    expect(body).not.toHaveProperty('userGroup');
  });

  const auditArgs = {
    email: 'lead@example.com',
    websiteUrl: 'https://example.com/',
    normalizedDomain: 'example.com',
    auditId: 'audit-1',
    auditScore: 0,
    pagesScanned: 0,
    imagesScanned: 0,
    missingAltPercent: 0,
    errorCode: 'AUDIT_FAILED'
  };

  test.each([
    'trackImageSeoAuditRequested',
    'trackImageSeoAuditCompleted',
    'trackImageSeoAuditFailed'
  ])('%s creates an audit lead with the default origin', async (helper) => {
    const loops = require('../../../src/services/loops');
    await loops[helper](auditArgs);

    const [url, options] = global.fetch.mock.calls[0];
    expect(url).toMatch(/\/contacts\/create$/);
    expect(options.method).toBe('POST');
    const body = JSON.parse(options.body);
    expect(body).toEqual(expect.objectContaining({
      email: auditArgs.email,
      userGroup: 'lead',
      source: 'image-seo-audit',
      subscribed: true
    }));
    expect(body).not.toHaveProperty('firstName');
    expect(JSON.parse(global.fetch.mock.calls[1][1].body).eventProperties.source).toBe('image-seo-audit');
  });

  test.each([
    ['trackImageSeoAuditRequested', {}],
    ['trackImageSeoAuditCompleted', { auditScore: 0, pagesScanned: 0, imagesScanned: 0, missingAltPercent: 0 }],
    ['trackImageSeoAuditFailed', {}]
  ])('%s updates only audit data on conflict', async (helper, metrics) => {
    global.fetch.mockResolvedValueOnce({
      ok: false,
      status: 409,
      json: jest.fn().mockResolvedValue({ message: 'Contact already exists' })
    });
    const loops = require('../../../src/services/loops');
    await loops[helper]({ ...auditArgs, source: 'custom-audit-source' });

    const [url, options] = global.fetch.mock.calls[1];
    expect(url).toMatch(/\/contacts\/update$/);
    expect(options.method).toBe('PUT');
    const body = JSON.parse(options.body);
    expect(body).toEqual({
      email: auditArgs.email,
      websiteUrl: auditArgs.websiteUrl,
      normalizedDomain: auditArgs.normalizedDomain,
      ...metrics
    });
    for (const key of ['subscribed', 'userGroup', 'source', 'firstName']) {
      expect(body).not.toHaveProperty(key);
    }
    expect(JSON.parse(global.fetch.mock.calls[0][1].body).source).toBe('custom-audit-source');
    expect(JSON.parse(global.fetch.mock.calls[2][1].body).eventProperties.source).toBe('custom-audit-source');
  });

  test('audit updates omit null metrics', async () => {
    global.fetch.mockResolvedValueOnce({ ok: false, status: 409, json: jest.fn().mockResolvedValue({}) });
    const { trackImageSeoAuditCompleted } = require('../../../src/services/loops');
    await trackImageSeoAuditCompleted({
      ...auditArgs,
      auditScore: null,
      pagesScanned: null,
      imagesScanned: null,
      missingAltPercent: null
    });
    expect(JSON.parse(global.fetch.mock.calls[1][1].body)).toEqual({
      email: auditArgs.email,
      websiteUrl: auditArgs.websiteUrl,
      normalizedDomain: auditArgs.normalizedDomain
    });
  });

  test('audit failures other than conflicts do not update the contact or send events', async () => {
    global.fetch.mockResolvedValueOnce({ ok: false, status: 500, json: jest.fn().mockResolvedValue({}) });
    const { trackImageSeoAuditRequested } = require('../../../src/services/loops');
    await expect(trackImageSeoAuditRequested(auditArgs)).rejects.toMatchObject({ status: 500 });
    expect(global.fetch).toHaveBeenCalledTimes(1);
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
      expect(global.fetch).toHaveBeenCalledTimes(6);
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
