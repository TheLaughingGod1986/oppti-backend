#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { Client } = require('pg');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const PROJECT_REF_PATH = path.join(REPO_ROOT, 'supabase', '.temp', 'project-ref');

const REQUIRED_TABLES = [
  'plans',
  'site_memberships',
  'site_subscriptions',
  'site_quotas',
  'site_trials',
  'generation_requests',
  'usage_events',
  'site_audit_logs',
  'site_merges'
];

const REQUIRED_FUNCTIONS = {
  bbai_reserve_site_generation: 'p_site_id uuid, p_user_id uuid, p_credits integer, p_idempotency_key text, p_request_fingerprint text, p_request_metadata jsonb, p_quota_mode text, p_trial_credits integer',
  bbai_finalize_site_generation: 'p_generation_request_id uuid, p_success boolean, p_final_metadata jsonb',
  bbai_apply_site_billing_event: 'p_site_id uuid, p_stripe_event_id text, p_plan_id text, p_purchase_type text, p_billing_interval text, p_stripe_customer_id text, p_stripe_subscription_id text, p_subscription_status text, p_current_period_start timestamp with time zone, p_current_period_end timestamp with time zone, p_metadata jsonb',
  bbai_merge_sites: 'p_source_site_id uuid, p_target_site_id uuid, p_actor_user_id uuid, p_reason text'
};

const REQUIRED_TRIAL_USAGE_COLUMNS = [
  'anon_id',
  'anonymous_risk_key',
  'ip_hash'
];

const REQUIRED_SITE_V2_COLUMNS = [
  'normalized_site_url',
  'canonical_domain',
  'site_fingerprint',
  'wp_install_uuid',
  'owner_user_id',
  'first_seen_at',
  'last_seen_at',
  'merged_into_site_id',
  'environment'
];

function parseArgs(argv) {
  return {
    pretty: argv.includes('--pretty')
  };
}

function parseSupabaseDryRunConnection(stdout) {
  const fields = ['PGHOST', 'PGPORT', 'PGUSER', 'PGPASSWORD', 'PGDATABASE'];
  const config = {};

  for (const field of fields) {
    const match = stdout.match(new RegExp(`export ${field}=\"([^\"]+)\"`));
    if (!match) {
      throw new Error(`Unable to parse ${field} from Supabase CLI dry-run output`);
    }
    config[field] = match[1];
  }

  return config;
}

function getProjectRef() {
  try {
    return fs.readFileSync(PROJECT_REF_PATH, 'utf8').trim();
  } catch (_error) {
    return null;
  }
}

function getLinkedPgConfig() {
  const stdout = execFileSync(
    'supabase',
    ['db', 'dump', '--linked', '--schema', 'public', '--dry-run'],
    {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024
    }
  );

  return parseSupabaseDryRunConnection(stdout);
}

async function queryTableAvailability(client) {
  const { rows } = await client.query(
    `
      SELECT c.relname AS table_name
      FROM pg_class c
      JOIN pg_namespace n
        ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relkind IN ('r', 'p')
        AND c.relname = ANY($1::text[])
    `,
    [REQUIRED_TABLES]
  );

  const present = new Set(rows.map((row) => row.table_name));
  return Object.fromEntries(
    REQUIRED_TABLES.map((table) => [table, present.has(table)])
  );
}

async function queryFunctionAvailability(client) {
  const { rows } = await client.query(
    `
      SELECT
        p.proname AS function_name,
        pg_get_function_identity_arguments(p.oid) AS identity_arguments,
        pg_get_function_result(p.oid) AS return_type
      FROM pg_proc p
      JOIN pg_namespace n
        ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND p.proname = ANY($1::text[])
    `,
    [Object.keys(REQUIRED_FUNCTIONS)]
  );

  const rowMap = new Map(rows.map((row) => [row.function_name, row]));

  return Object.fromEntries(
    Object.entries(REQUIRED_FUNCTIONS).map(([functionName, expectedIdentity]) => {
      const row = rowMap.get(functionName);
      return [
        functionName,
        {
          present: Boolean(row),
          identity_arguments: row?.identity_arguments || null,
          expected_identity_arguments: expectedIdentity,
          identity_matches: row?.identity_arguments === expectedIdentity,
          return_type: row?.return_type || null,
          return_type_matches: row?.return_type === 'jsonb'
        }
      ];
    })
  );
}

async function queryColumnAvailability(client, tableName, requiredColumns) {
  const { rows } = await client.query(
    `
      SELECT
        a.attname AS column_name,
        pg_get_expr(d.adbin, d.adrelid) AS column_default
      FROM pg_attribute a
      JOIN pg_class c
        ON c.oid = a.attrelid
      JOIN pg_namespace n
        ON n.oid = c.relnamespace
      LEFT JOIN pg_attrdef d
        ON d.adrelid = a.attrelid
       AND d.adnum = a.attnum
      WHERE n.nspname = 'public'
        AND c.relname = $1
        AND a.attnum > 0
        AND NOT a.attisdropped
        AND a.attname = ANY($2::text[])
    `,
    [tableName, requiredColumns]
  );

  const rowMap = new Map(rows.map((row) => [row.column_name, row]));

  return Object.fromEntries(
    requiredColumns.map((columnName) => [
      columnName,
      {
        present: rowMap.has(columnName),
        column_default: rowMap.get(columnName)?.column_default || null
      }
    ])
  );
}

async function queryTriggerAvailability(client) {
  const { rows } = await client.query(
    `
      SELECT
        t.tgname AS trigger_name,
        c.relname AS table_name,
        p.proname AS function_name
      FROM pg_trigger t
      JOIN pg_class c
        ON c.oid = t.tgrelid
      JOIN pg_namespace n
        ON n.oid = c.relnamespace
      JOIN pg_proc p
        ON p.oid = t.tgfoid
      WHERE n.nspname = 'public'
        AND NOT t.tgisinternal
        AND t.tgname = 'trg_update_quota_summary'
    `
  );

  const trigger = rows[0] || null;
  return {
    present: Boolean(trigger),
    table_name: trigger?.table_name || null,
    function_name: trigger?.function_name || null
  };
}

function buildMissing(summary) {
  return {
    tables: Object.entries(summary.tables)
      .filter(([, present]) => !present)
      .map(([name]) => name),
    functions: Object.entries(summary.functions)
      .filter(([, status]) => !(status.present && status.identity_matches && status.return_type_matches))
      .map(([name]) => name),
    trial_usage_columns: Object.entries(summary.trial_usage_columns)
      .filter(([, status]) => !status.present)
      .map(([name]) => name),
    site_v2_columns: Object.entries(summary.site_v2_columns)
      .filter(([, status]) => !status.present)
      .map(([name]) => name),
    triggers: summary.trigger.present ? [] : ['trg_update_quota_summary'],
    site_trials_defaults: summary.site_trials_total_trial_credits_default_matches ? [] : ['site_trials.total_trial_credits']
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const projectRef = getProjectRef();
  const pgConfig = getLinkedPgConfig();

  const client = new Client({
    host: pgConfig.PGHOST,
    port: Number(pgConfig.PGPORT),
    user: pgConfig.PGUSER,
    password: pgConfig.PGPASSWORD,
    database: pgConfig.PGDATABASE,
    ssl: { rejectUnauthorized: false }
  });

  await client.connect();

  try {
    const tables = await queryTableAvailability(client);
    const functions = await queryFunctionAvailability(client);
    const trialUsageColumns = await queryColumnAvailability(client, 'trial_usage', REQUIRED_TRIAL_USAGE_COLUMNS);
    const siteV2Columns = await queryColumnAvailability(client, 'sites', REQUIRED_SITE_V2_COLUMNS);
    const trigger = await queryTriggerAvailability(client);

    const siteTrialsDefault = await queryColumnAvailability(client, 'site_trials', ['total_trial_credits']);
    const siteTrialsDefaultValue = siteTrialsDefault.total_trial_credits?.column_default || null;
    const siteTrialsDefaultMatches = siteTrialsDefaultValue === '5';

    const summary = {
      ok: false,
      checked_at: new Date().toISOString(),
      project_ref: projectRef,
      host: pgConfig.PGHOST,
      tables,
      functions,
      trial_usage_columns: trialUsageColumns,
      site_v2_columns: siteV2Columns,
      site_trials_total_trial_credits_default: siteTrialsDefaultValue,
      site_trials_total_trial_credits_default_matches: siteTrialsDefaultMatches,
      trigger
    };

    summary.missing = buildMissing(summary);
    summary.ok = Object.values(summary.missing).every((bucket) => bucket.length === 0);

    const text = JSON.stringify(summary, null, args.pretty ? 2 : 0);
    process.stdout.write(`${text}\n`);
    process.exit(summary.ok ? 0 : 1);
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  main().catch((error) => {
    const payload = {
      ok: false,
      error: error.message
    };
    process.stderr.write(`${JSON.stringify(payload, null, 2)}\n`);
    process.exit(1);
  });
}

module.exports = {
  parseSupabaseDryRunConnection
};
