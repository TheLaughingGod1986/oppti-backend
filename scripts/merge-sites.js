#!/usr/bin/env node

const {
  createSupabase,
  getArgValue,
  hasFlag
} = require('./_site-quota-utils');

// Operator-only helper for manual duplicate-site resolution. Live backend
// request paths do not invoke bbai_merge_sites directly.
async function main() {
  const supabase = createSupabase();
  const sourceSiteId = getArgValue('--source');
  const targetSiteId = getArgValue('--target');
  const actorUserId = getArgValue('--actor');
  const execute = hasFlag('--write');

  if (!sourceSiteId || !targetSiteId) {
    throw new Error('Usage: node scripts/merge-sites.js --source <site-id> --target <site-id> [--actor <user-id>] [--write]');
  }

  if (!execute) {
    console.log(JSON.stringify({
      dryRun: true,
      sourceSiteId,
      targetSiteId,
      actorUserId: actorUserId || null,
      note: 'Re-run with --write to execute bbai_merge_sites'
    }, null, 2));
    return;
  }

  const { data, error } = await supabase.rpc('bbai_merge_sites', {
    p_source_site_id: sourceSiteId,
    p_target_site_id: targetSiteId,
    p_actor_user_id: actorUserId || null
  });

  if (error) throw error;
  console.log(JSON.stringify({ dryRun: false, data }, null, 2));
}

main().catch((error) => {
  console.error('[merge-sites] failed:', error.message);
  process.exit(1);
});
