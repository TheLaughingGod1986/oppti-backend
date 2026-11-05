const {
  PLUGINS,
  PLUGIN_IDS,
  LOOPS_SOURCE_BY_PLUGIN,
  getPlugin,
  normalizePluginId,
  pluginIdFromFeatureType
} = require('../../../src/services/pluginIdentity');

describe('plugin identity', () => {
  test('includes content refresh and preserves alt text as the default', () => {
    expect(PLUGIN_IDS).toEqual(['alt_text', 'titles', 'internal_linking', 'content_refresh']);
    expect(PLUGINS.internal_linking).toEqual({
      id: 'internal_linking',
      title: 'OpptiAI Internal Linking',
      featureType: 'internal_linking'
    });
    expect(PLUGINS.content_refresh).toEqual({
      id: 'content_refresh',
      title: 'OpptiAI Content Refresh',
      featureType: 'content_refresh'
    });
    expect(normalizePluginId('nonsense')).toBe('alt_text');
    expect(getPlugin().id).toBe('alt_text');
    expect(normalizePluginId(' INTERNAL_LINKING ')).toBe('internal_linking');
    expect(normalizePluginId(' content_refresh ')).toBe('content_refresh');
  });

  test('defines the agreed source slugs', () => {
    expect(LOOPS_SOURCE_BY_PLUGIN).toEqual({
      alt_text: 'alt-text',
      titles: 'titles',
      internal_linking: 'internal-linking',
      content_refresh: 'content-refresh'
    });
  });

  test.each([
    ['titles', 'titles'],
    ['title_meta', 'titles'],
    ['internal_linking', 'internal_linking'],
    ['content_refresh', 'content_refresh'],
    ['alt_text', 'alt_text'],
    [undefined, 'alt_text'],
    ['nonsense', 'alt_text']
  ])('maps feature type %s to %s', (featureType, pluginId) => {
    expect(pluginIdFromFeatureType(featureType)).toBe(pluginId);
  });
});
