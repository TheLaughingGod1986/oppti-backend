jest.mock('../../services/pluginConnections', () => ({
  recordPluginConnection: jest.fn()
}));
jest.mock('../../../src/services/loops', () => ({
  trackPluginConnected: jest.fn()
}));
jest.mock('../../lib/productEmailOptOut', () => ({
  isProductEmailsOptedOut: () => false
}));

const { recordPluginConnection } = require('../../services/pluginConnections');
const { trackPluginConnected } = require('../../../src/services/loops');
const { recordContentRefreshConnection } = require('../../services/contentRefreshConnection');

describe('recordContentRefreshConnection', () => {
  const supabase = {};
  const account = { id: 'lic-1', email: 'person@site.test' };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.LOOPS_API_KEY = 'test-key';
  });

  test('first connection records content_refresh row and updates Loops', async () => {
    recordPluginConnection.mockResolvedValue({ isFirstConnection: true, error: null });
    await recordContentRefreshConnection(supabase, { account, pluginVersion: '0.1.1' });
    expect(recordPluginConnection).toHaveBeenCalledWith(supabase, {
      accountId: 'lic-1',
      pluginId: 'content_refresh',
      pluginVersion: '0.1.1'
    });
    expect(trackPluginConnected).toHaveBeenCalledWith(expect.objectContaining({
      email: 'person@site.test',
      userId: 'lic-1',
      pluginId: 'content_refresh',
      emitEvent: true
    }));
  });

  test('repeat connection skips Loops', async () => {
    recordPluginConnection.mockResolvedValue({ isFirstConnection: false, error: null });
    await recordContentRefreshConnection(supabase, { account, pluginVersion: '0.1.1' });
    expect(trackPluginConnected).not.toHaveBeenCalled();
  });

  test('never throws when Loops fails', async () => {
    recordPluginConnection.mockResolvedValue({ isFirstConnection: true, error: null });
    trackPluginConnected.mockRejectedValue(new Error('loops down'));
    await expect(recordContentRefreshConnection(supabase, { account })).resolves.toEqual({
      recorded: true,
      isFirstConnection: true
    });
  });
});
