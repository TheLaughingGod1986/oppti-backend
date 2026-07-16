async function recordPluginConnection(supabase, {
  accountId,
  pluginId,
  pluginVersion,
  connectedAt = new Date().toISOString()
}) {
  if (!supabase || !accountId || !pluginId) return { isFirstConnection: false, error: null };

  const { data: existing, error: lookupError } = await supabase
    .from('account_plugin_connections')
    .select('id')
    .eq('license_id', accountId)
    .eq('plugin_id', pluginId)
    .maybeSingle();
  if (lookupError) return { isFirstConnection: false, error: lookupError };

  if (existing) {
    const { error } = await supabase
      .from('account_plugin_connections')
      .update({
        plugin_version: pluginVersion || null,
        last_connected_at: connectedAt
      })
      .eq('id', existing.id);
    return { isFirstConnection: false, error };
  }

  const { error } = await supabase.from('account_plugin_connections').insert({
    license_id: accountId,
    plugin_id: pluginId,
    plugin_version: pluginVersion || null,
    first_connected_at: connectedAt,
    last_connected_at: connectedAt
  });
  return {
    isFirstConnection: !error,
    error: error?.code === '23505' ? null : error
  };
}

module.exports = { recordPluginConnection };
