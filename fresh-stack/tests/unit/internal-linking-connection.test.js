jest.mock('../../../src/services/loops', () => ({ trackPluginConnected: jest.fn(async () => {}) }));
jest.mock('../../services/pluginConnections', () => ({ recordPluginConnection: jest.fn() }));

const { trackPluginConnected } = require('../../../src/services/loops');
const { recordPluginConnection } = require('../../services/pluginConnections');
const { recordInternalLinkingConnection } = require('../../services/internalLinkingConnection');

const supabase = {};
const account = { id: 'lic-1', email: 'person@site.test' };

describe('recordInternalLinkingConnection', () => {
  const OLD = process.env.LOOPS_API_KEY;
  beforeEach(() => { jest.clearAllMocks(); process.env.LOOPS_API_KEY = 'test-key'; });
  afterAll(() => { process.env.LOOPS_API_KEY = OLD; });

  test('first connection records internal_linking row and updates Loops', async () => {
    recordPluginConnection.mockResolvedValue({ isFirstConnection: true, error: null });
    const out = await recordInternalLinkingConnection(supabase, { account, pluginVersion: '0.1.4' });
    expect(recordPluginConnection).toHaveBeenCalledWith(supabase, { accountId: 'lic-1', pluginId: 'internal_linking', pluginVersion: '0.1.4' });
    expect(trackPluginConnected).toHaveBeenCalledWith(expect.objectContaining({ email: 'person@site.test', userId: 'lic-1', pluginId: 'internal_linking', emitEvent: true }));
    expect(out).toEqual({ recorded: true, isFirstConnection: true });
  });

  test('repeat connection only refreshes the row, no Loops call', async () => {
    recordPluginConnection.mockResolvedValue({ isFirstConnection: false, error: null });
    await recordInternalLinkingConnection(supabase, { account });
    expect(trackPluginConnected).not.toHaveBeenCalled();
  });

  test('no account id: nothing written', async () => {
    const out = await recordInternalLinkingConnection(supabase, { account: { license_key: 'k' } });
    expect(recordPluginConnection).not.toHaveBeenCalled();
    expect(out.recorded).toBe(false);
  });

  test('no LOOPS_API_KEY: row recorded, Loops skipped', async () => {
    delete process.env.LOOPS_API_KEY;
    recordPluginConnection.mockResolvedValue({ isFirstConnection: true, error: null });
    await recordInternalLinkingConnection(supabase, { account });
    expect(trackPluginConnected).not.toHaveBeenCalled();
  });

  test('errors never throw', async () => {
    recordPluginConnection.mockRejectedValue(new Error('db down'));
    await expect(recordInternalLinkingConnection(supabase, { account })).resolves.toEqual({ recorded: false, isFirstConnection: false });
    recordPluginConnection.mockResolvedValue({ isFirstConnection: true, error: null });
    trackPluginConnected.mockRejectedValueOnce(new Error('loops 500'));
    await expect(recordInternalLinkingConnection(supabase, { account })).resolves.toEqual({ recorded: true, isFirstConnection: true });
  });
});

describe('Loops skip list still applies to Internal Linking connections', () => {
  test('qa.oppti.dev and other skipped domains never reach Loops', () => {
    const { isLoopsSkippedEmail } = jest.requireActual('../../../src/services/loops');
    for (const e of ['a@qa.oppti.dev', 'b@example.invalid', 'c@maxxspace.com', 'd@uberip.com']) {
      expect(isLoopsSkippedEmail(e)).toBe(true);
    }
    expect(isLoopsSkippedEmail('person@site.test')).toBe(false);
  });
});
