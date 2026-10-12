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
  }),
  internal_linking: Object.freeze({
    id: 'internal_linking',
    title: 'OpptiAI Internal Linking',
    featureType: 'internal_linking'
  })
});

const PLUGIN_IDS = Object.freeze(Object.keys(PLUGINS));

function normalizePluginId(value, fallback = 'alt_text') {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (PLUGINS[normalized]) return normalized;
  if (normalized === 'linking') return 'internal_linking';
  return fallback;
}

function getPlugin(value, fallback = 'alt_text') {
  return PLUGINS[normalizePluginId(value, fallback)];
}

function pluginIdFromFeatureType(featureType) {
  if (featureType === 'titles' || featureType === 'title_meta') return 'titles';
  if (featureType === 'internal_linking') return 'internal_linking';
  return 'alt_text';
}

module.exports = {
  PLUGINS,
  PLUGIN_IDS,
  getPlugin,
  normalizePluginId,
  pluginIdFromFeatureType
};
