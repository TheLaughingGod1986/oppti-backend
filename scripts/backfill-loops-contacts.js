/**
 * Backfill Loops contact identities and plugin memberships from backend usage.
 * Dry-run is the default. Add --write to update Loops contacts.
 */

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { upsertPluginContact } = require('../src/services/loops');
const { getPlugin, pluginIdFromFeatureType } = require('../src/services/pluginIdentity');

const write = process.argv.includes('--write');
const emailArg = process.argv.find((arg) => arg.startsWith('--email='));
const limitArg = process.argv.find((arg) => arg.startsWith('--limit='));
const emailFilter = emailArg ? emailArg.slice('--email='.length).trim().toLowerCase() : null;
const limit = limitArg ? Number(limitArg.slice('--limit='.length)) : null;

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}
if (write && (!process.env.LOOPS_API_KEY || !process.env.LOOPS_PLUGIN_USERS_LIST_ID)) {
  console.error('--write requires LOOPS_API_KEY and LOOPS_PLUGIN_USERS_LIST_ID');
  process.exit(1);
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

function membershipExtra(pluginId, firstSeenAt) {
  return pluginId === 'titles'
    ? { titlesFirstSeenAt: firstSeenAt }
    : { altTextFirstSeenAt: firstSeenAt };
}

async function main() {
  let accountQuery = supabase
    .from('licenses')
    .select('id, email, plan, created_at')
    .not('email', 'is', null)
    .eq('status', 'active')
    .order('created_at', { ascending: true });
  if (emailFilter) accountQuery = accountQuery.eq('email', emailFilter);
  if (limit && Number.isInteger(limit) && limit > 0) accountQuery = accountQuery.limit(limit);

  const { data: accounts, error: accountError } = await accountQuery;
  if (accountError) throw accountError;

  const accountIds = (accounts || []).map((account) => account.id);
  const { data: usageRows, error: usageError } = accountIds.length
    ? await supabase
      .from('usage_logs')
      .select('license_id, feature_type, plugin_version, created_at')
      .in('license_id', accountIds)
      .eq('status', 'success')
      .order('created_at', { ascending: true })
    : { data: [], error: null };
  if (usageError) throw usageError;

  const usageByAccount = new Map();
  for (const row of usageRows || []) {
    const pluginId = pluginIdFromFeatureType(row.feature_type);
    const memberships = usageByAccount.get(row.license_id) || new Map();
    const existing = memberships.get(pluginId);
    memberships.set(pluginId, {
      firstSeenAt: existing?.firstSeenAt || row.created_at,
      lastSeenAt: row.created_at,
      pluginVersion: row.plugin_version || existing?.pluginVersion || ''
    });
    usageByAccount.set(row.license_id, memberships);
  }

  console.log(`${write ? 'WRITE' : 'DRY RUN'}: ${accounts.length} active Loops contacts`);
  for (const account of accounts || []) {
    const memberships = usageByAccount.get(account.id) || new Map([
      ['alt_text', { firstSeenAt: account.created_at, lastSeenAt: account.created_at, pluginVersion: '' }]
    ]);
    const ordered = [...memberships.entries()].sort((left, right) =>
      new Date(left[1].firstSeenAt) - new Date(right[1].firstSeenAt));
    const acquisitionPluginId = ordered[0][0];

    console.log(JSON.stringify({
      accountId: account.id,
      email: account.email,
      acquisitionPluginId,
      plugins: ordered.map(([pluginId]) => pluginId)
    }));

    if (!write) continue;
    for (const [pluginId, membership] of ordered) {
      const { error: connectionError } = await supabase.from('account_plugin_connections').upsert({
        license_id: account.id,
        plugin_id: pluginId,
        plugin_version: membership.pluginVersion || null,
        first_connected_at: membership.firstSeenAt,
        last_connected_at: membership.lastSeenAt
      }, { onConflict: 'license_id,plugin_id' });
      if (connectionError) throw connectionError;
      await upsertPluginContact({
        email: account.email,
        userId: account.id,
        pluginId,
        pluginVersion: membership.pluginVersion,
        acquisition: pluginId === acquisitionPluginId,
        timestamp: membership.lastSeenAt,
        extra: {
          ...membershipExtra(pluginId, membership.firstSeenAt),
          plan: account.plan || 'free',
          acquisitionPluginId,
          acquisitionPluginTitle: getPlugin(acquisitionPluginId).title
        }
      });
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
