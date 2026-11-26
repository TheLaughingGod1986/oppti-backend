#!/usr/bin/env node
/**
 * One-off backfill of licenses.signup_plugin for accounts created before the
 * register route wrote it (12 Oct 2026). NOT a migration and never run on
 * deploy: run by hand only.
 *
 * Dry-run is the default and prints counts only (no emails, ids, licence
 * keys, site hashes or URLs). Writing needs --apply.
 *
 *   node scripts/backfill-signup-plugin.js
 *   node scripts/backfill-signup-plugin.js --stripe-file=stripe.json --posthog-file=posthog.json
 *   node scripts/backfill-signup-plugin.js --apply
 *
 * Rules (fresh-stack/lib/signupPluginBackfill.js): fill blanks only, never
 * overwrite; Auditor-referred accounts -> website_auditor; then first usage
 * row, Stripe checkout metadata, first consented PostHog event, first plugin
 * connection; otherwise leave null. Every filled row gets
 * signup_plugin_source (migration 030 adds the column).
 *
 * Stripe and PostHog are read from local JSON exports, never from their
 * APIs, so this script needs no Stripe or PostHog key. Each file is an array:
 *   stripe:  [{ "license_id": "...", "created_at": "...", "metadata": { "plugin_id": "titles" } }]
 *   posthog: [{ "license_id": "...", "timestamp": "...", "plugin": "titles", "consented": true }]
 * Without a file that step is skipped (reported in the output).
 *
 * Scope: licenses with a password (login accounts) and a blank signup_plugin,
 * excluding test domains (@qa.oppti.dev, @maxxspace.com, @uberip.com,
 * @example.invalid).
 */

const fs = require('fs');
const {
  inferSignupPlugin,
  isExcludedEmail,
  summarize
} = require('../fresh-stack/lib/signupPluginBackfill');

function parseArgs(argv) {
  const args = { apply: false, stripeFile: null, posthogFile: null };
  for (const arg of argv) {
    if (arg === '--apply') args.apply = true;
    else if (arg.startsWith('--stripe-file=')) args.stripeFile = arg.slice('--stripe-file='.length);
    else if (arg.startsWith('--posthog-file=')) args.posthogFile = arg.slice('--posthog-file='.length);
    else if (arg === '--write') throw new Error('Use --apply to write.');
  }
  return args;
}

function loadExport(file) {
  if (!file) return null;
  const rows = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(rows)) throw new Error('export file must be a JSON array');
  const byAccount = new Map();
  for (const row of rows) {
    if (!row || !row.license_id) continue;
    if (!byAccount.has(row.license_id)) byAccount.set(row.license_id, []);
    byAccount.get(row.license_id).push(row);
  }
  return byAccount;
}

function groupBy(rows, key) {
  const map = new Map();
  for (const row of rows || []) {
    const k = row[key];
    if (!k) continue;
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(row);
  }
  return map;
}

async function fetchAll(query, pageSize = 1000) {
  const out = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await query().range(from, from + pageSize - 1);
    if (error) throw new Error(`read failed: ${error.message}`);
    out.push(...(data || []));
    if (!data || data.length < pageSize) break;
  }
  return out;
}

async function run({ supabase, apply = false, stripe = null, posthog = null, log = console.log }) {
  const accounts = await fetchAll(() => supabase
    .from('licenses')
    .select('id, email, signup_plugin, signup_source_auditor, auditor_finding, created_at')
    .not('password_hash', 'is', null)
    .is('signup_plugin', null)
    .order('created_at', { ascending: true }));

  const inScope = accounts.filter((a) => !isExcludedEmail(a.email));
  const ids = inScope.map((a) => a.id);

  const usage = [];
  const connections = [];
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    usage.push(...await fetchAll(() => supabase
      .from('usage_logs')
      .select('license_id, endpoint, feature_type, created_at')
      .in('license_id', chunk)
      .order('created_at', { ascending: true })));
    connections.push(...await fetchAll(() => supabase
      .from('account_plugin_connections')
      .select('license_id, plugin_id, first_connected_at')
      .in('license_id', chunk)
      .order('first_connected_at', { ascending: true })));
  }
  const usageBy = groupBy(usage, 'license_id');
  const connectionsBy = groupBy(connections, 'license_id');

  const results = accounts.map((account) => {
    if (isExcludedEmail(account.email)) return { id: account.id, skipped: 'excluded_email' };
    const inferred = inferSignupPlugin(account, {
      usage: usageBy.get(account.id) || [],
      stripe: stripe ? stripe.get(account.id) || [] : [],
      posthog: posthog ? posthog.get(account.id) || [] : [],
      connections: connectionsBy.get(account.id) || []
    });
    return { id: account.id, ...inferred };
  });

  const summary = summarize(results);
  summary.mode = apply ? 'apply' : 'dry_run';
  summary.steps_skipped = [!stripe && 'stripe_checkout (no --stripe-file)', !posthog && 'posthog (no --posthog-file)'].filter(Boolean);

  if (apply) {
    let written = 0;
    let unchanged = 0;
    for (const r of results) {
      if (!r.plugin) continue;
      const { data, error } = await supabase
        .from('licenses')
        .update({ signup_plugin: r.plugin, signup_plugin_source: r.source })
        .eq('id', r.id)
        .is('signup_plugin', null) // never overwrite, even if set since the read
        .select('id');
      if (error) throw new Error(`write failed: ${error.message}`);
      if (Array.isArray(data) && data.length) written += 1; else unchanged += 1;
    }
    summary.written = written;
    summary.unchanged_since_read = unchanged;
  }

  log(JSON.stringify(summary, null, 2));
  return summary;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  require('dotenv').config();
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
    process.exit(1);
  }
  const { createClient } = require('@supabase/supabase-js');
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  await run({
    supabase,
    apply: args.apply,
    stripe: loadExport(args.stripeFile),
    posthog: loadExport(args.posthogFile)
  });
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}

module.exports = { parseArgs, run, loadExport };
