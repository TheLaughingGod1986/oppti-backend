const PLUGINS = Object.freeze({
  alt_text: Object.freeze({
    id: 'alt_text',
    title: 'BeepBeep AI - Alt Text Generator',
    featureType: 'alt_text'
  }),
  titles: Object.freeze({
    id: 'titles',
    title: 'BeepBeep Titles',
    featureType: 'titles'
  })
});

const PLUGIN_IDS = Object.freeze(Object.keys(PLUGINS));

function normalizePluginId(value, fallback = 'alt_text') {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (PLUGINS[normalized]) return normalized;
  return fallback;
}

function getPlugin(value, fallback = 'alt_text') {
  return PLUGINS[normalizePluginId(value, fallback)];
}

function pluginIdFromFeatureType(featureType) {
  return featureType === 'titles' ? 'titles' : 'alt_text';
}

module.exports = {
  PLUGINS,
  PLUGIN_IDS,
  getPlugin,
  normalizePluginId,
  pluginIdFromFeatureType
};
