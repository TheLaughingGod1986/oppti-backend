const fs = require('fs');
const path = require('path');
const logger = require('../lib/logger');
const { inspectV2Schema } = require('./v2Diagnostics');
const { isMissingSchemaError, serializeSupabaseError } = require('../lib/supabaseErrors');
const packageJson = require('../../package.json');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const PROCESS_STARTED_AT = new Date().toISOString();
const ROUTE_VERSION_MARKER = 'data-integrity-runtime-v1';
const SOURCE_SCAN_PATHS = [
  path.resolve(__dirname, '..', 'routes'),
  path.resolve(__dirname, '..', 'services'),
  path.resolve(__dirname, '..', 'middleware'),
  path.resolve(__dirname, '..', 'lib'),
  path.resolve(__dirname, '..', 'server.js'),
  path.resolve(REPO_ROOT, 'src', 'services', 'loops.js')
];

// Classification is intentionally explicit because operators need a stable
// backend-side verdict, not just raw row counts.
const TABLE_HEALTH_CONFIG = {
  sites: {
    timeColumns: ['last_seen_at', 'first_seen_at', 'updated_at', 'activated_at'],
    sampleColumns: ['id', 'site_hash', 'license_key', 'owner_user_id', 'status', 'site_url', 'canonical_domain', 'wp_install_uuid'],
    criticalColumns: ['id', 'site_hash', 'status'],
    expectedNullHeavyColumns: ['license_key', 'owner_user_id', 'site_url', 'canonical_domain', 'wp_install_uuid']
  },
  trial_usage: {
    timeColumns: ['created_at'],
    sampleColumns: ['id', 'site_hash', 'anon_id', 'anonymous_risk_key', 'site_url', 'site_fingerprint', 'created_at'],
    criticalColumns: ['id', 'site_hash', 'created_at'],
    expectedNullHeavyColumns: ['anon_id', 'anonymous_risk_key', 'site_url', 'site_fingerprint']
  },
  usage_logs: {
    timeColumns: ['created_at'],
    sampleColumns: ['id', 'license_key', 'license_id', 'site_hash', 'user_id', 'user_email', 'status', 'endpoint', 'error_message', 'created_at'],
    criticalColumns: ['id', 'license_key', 'site_hash', 'created_at'],
    expectedNullHeavyColumns: ['license_id', 'user_id', 'user_email', 'error_message']
  },
  licenses: {
    timeColumns: ['created_at', 'updated_at', 'billing_anchor_date', 'last_generation_at'],
    sampleColumns: ['id', 'license_key', 'email', 'plan', 'status', 'stripe_customer_id', 'stripe_subscription_id', 'billing_cycle'],
    criticalColumns: ['id', 'license_key', 'email', 'plan', 'status'],
    expectedNullHeavyColumns: ['stripe_customer_id', 'stripe_subscription_id', 'billing_cycle']
  },
  quota_summaries: {
    timeColumns: ['updated_at', 'period_start', 'period_end'],
    sampleColumns: ['id', 'license_key', 'period_start', 'period_end', 'total_credits_used', 'total_limit', 'site_usage', 'updated_at'],
    criticalColumns: ['license_key', 'period_start', 'period_end', 'total_credits_used', 'total_limit'],
    expectedNullHeavyColumns: ['site_usage']
  },
  dashboard_sessions: {
    timeColumns: ['created_at', 'last_activity_at', 'expires_at'],
    sampleColumns: ['id', 'license_key', 'session_token', 'created_at', 'last_activity_at', 'expires_at', 'user_agent', 'ip_address'],
    criticalColumns: ['id', 'license_key', 'session_token', 'expires_at'],
    expectedNullHeavyColumns: ['user_agent', 'ip_address']
  },
  debug_logs: {
    timeColumns: ['created_at'],
    sampleColumns: ['id', 'license_key', 'site_hash', 'level', 'message', 'error_code', 'endpoint', 'http_status', 'created_at'],
    criticalColumns: ['id', 'level', 'message', 'created_at'],
    expectedNullHeavyColumns: ['license_key', 'site_hash', 'error_code', 'endpoint', 'http_status']
  },
  subscriptions: {
    timeColumns: ['updated_at', 'created_at', 'current_period_end'],
    sampleColumns: ['id', 'license_key', 'site_id', 'plan', 'status', 'stripe_customer_id', 'stripe_subscription_id', 'current_period_end', 'updated_at'],
    criticalColumns: ['id', 'license_key', 'plan', 'status', 'stripe_customer_id', 'stripe_subscription_id'],
    expectedNullHeavyColumns: ['site_id']
  },
  site_subscriptions: {
    timeColumns: ['updated_at', 'created_at', 'current_period_end'],
    sampleColumns: ['id', 'site_id', 'plan_id', 'status', 'billing_interval', 'stripe_customer_id', 'stripe_subscription_id', 'current_period_end', 'updated_at'],
    criticalColumns: ['id', 'site_id', 'plan_id', 'status'],
    expectedNullHeavyColumns: ['stripe_customer_id', 'stripe_subscription_id', 'current_period_end']
  },
  site_trials: {
    timeColumns: ['updated_at', 'created_at', 'started_at', 'exhausted_at'],
    sampleColumns: ['id', 'site_id', 'trial_type', 'status', 'total_trial_credits', 'used_trial_credits', 'started_at', 'exhausted_at'],
    criticalColumns: ['id', 'site_id', 'status', 'total_trial_credits'],
    expectedNullHeavyColumns: ['exhausted_at']
  },
  generation_requests: {
    timeColumns: ['updated_at', 'created_at', 'finalized_at'],
    sampleColumns: ['id', 'site_id', 'user_id', 'quota_source', 'status', 'credits_reserved', 'credits_consumed', 'created_at', 'finalized_at'],
    criticalColumns: ['id', 'site_id', 'quota_source', 'status', 'credits_reserved'],
    expectedNullHeavyColumns: ['user_id', 'finalized_at']
  },
  usage_events: {
    timeColumns: ['created_at'],
    sampleColumns: ['id', 'site_id', 'user_id', 'generation_id', 'event_type', 'credits_delta', 'created_at'],
    criticalColumns: ['id', 'site_id', 'event_type', 'credits_delta', 'created_at'],
    expectedNullHeavyColumns: ['user_id', 'generation_id']
  },
  v_license_quota_current: {
    timeColumns: ['period_end', 'period_start', 'billing_anchor_date'],
    sampleColumns: ['license_key', 'plan', 'license_status', 'billing_anchor_date', 'period_start', 'period_end', 'credits_used', 'credits_remaining', 'site_usage'],
    criticalColumns: ['license_key', 'plan', 'license_status'],
    expectedNullHeavyColumns: ['period_start', 'period_end', 'site_usage']
  }
};

const CLASSIFICATION_HINTS = {
  sites: 'ACTIVE',
  trial_usage: 'ACTIVE',
  usage_logs: 'ACTIVE',
  licenses: 'ACTIVE',
  quota_summaries: 'ACTIVE',
  dashboard_sessions: 'EXPECTED_EMPTY',
  debug_logs: 'DEAD',
  subscriptions: 'DEAD',
  site_subscriptions: 'ACTIVE',
  site_trials: 'ACTIVE',
  generation_requests: 'ACTIVE',
  usage_events: 'ACTIVE',
  v_license_quota_current: 'LEGACY'
};

let sourceScanCache = null;

function getSupabaseUrlHost(url = process.env.SUPABASE_URL) {
  if (!url) return null;
  try {
    return new URL(url).host || null;
  } catch (_error) {
    return null;
  }
}

function getRuntimeIdentity({
  serviceName = packageJson.name || 'alttext-ai-api',
  diagnosticsRouteEnabled = true,
  routeVersionMarker = ROUTE_VERSION_MARKER,
  serverEntry = 'fresh-stack/server.js'
} = {}) {
  return {
    service_name: serviceName,
    app_version: packageJson.version || null,
    git_sha: process.env.RENDER_GIT_COMMIT || process.env.GIT_SHA || process.env.SOURCE_VERSION || null,
    build_id: process.env.RENDER_DEPLOY_ID || process.env.BUILD_ID || process.env.RENDER_INSTANCE_ID || null,
    process_started_at: PROCESS_STARTED_AT,
    process_uptime_seconds: Math.floor(process.uptime()),
    route_version_marker: routeVersionMarker,
    diagnostics_route_enabled: Boolean(diagnosticsRouteEnabled),
    server_entry: serverEntry,
    node_env: process.env.NODE_ENV || 'development',
    supabase_url_host: getSupabaseUrlHost()
  };
}

function logSupabaseTargetStartup() {
  logger.info('[diag] SUPABASE_URL host', {
    supabase_url_host: getSupabaseUrlHost(),
    node_env: process.env.NODE_ENV || 'development',
    has_service_role_key: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
    loops_enabled: Boolean(process.env.LOOPS_API_KEY),
    stripe_enabled: Boolean(process.env.STRIPE_SECRET_KEY)
  });
}

function logRuntimeIdentityStartup(options = {}) {
  logger.info('[init] runtime_identity', getRuntimeIdentity(options));
}

function collectSourceFiles(targetPath, output = []) {
  if (!fs.existsSync(targetPath)) {
    return output;
  }

  const stats = fs.statSync(targetPath);
  if (stats.isFile()) {
    if (targetPath.endsWith('.js')) {
      output.push(targetPath);
    }
    return output;
  }

  for (const entry of fs.readdirSync(targetPath, { withFileTypes: true })) {
    const entryPath = path.join(targetPath, entry.name);
    if (entry.isDirectory()) {
      collectSourceFiles(entryPath, output);
      continue;
    }
    if (entry.isFile() && entryPath.endsWith('.js')) {
      output.push(entryPath);
    }
  }

  return output;
}

function relativeSourcePath(filePath) {
  return path.relative(REPO_ROOT, filePath).replace(/\\/g, '/');
}

function lineFromIndex(source, index) {
  return source.slice(0, index).split('\n').length;
}

function rememberRef(container, key, ref) {
  if (!container[key]) {
    container[key] = { writes: [], reads: [] };
  }
  const bucket = ref.type === 'read' ? container[key].reads : container[key].writes;
  bucket.push(ref);
}

function scanSourceFile(filePath, scan) {
  const source = fs.readFileSync(filePath, 'utf8');
  const file = relativeSourcePath(filePath);

  const tableRegex = /\.from\((['"])([^'"]+)\1\)([\s\S]{0,240}?)\.(insert|update|upsert|delete|select)\(/g;
  let tableMatch;
  while ((tableMatch = tableRegex.exec(source))) {
    const [, , table, windowText, operation] = tableMatch;
    const ref = {
      file,
      line: lineFromIndex(source, tableMatch.index),
      operation,
      type: operation === 'select' ? 'read' : 'write',
      snippet: `.from('${table}')${windowText.replace(/\s+/g, ' ')}.${operation}(...)`
    };
    rememberRef(scan.tables, table, ref);
  }

  const rpcRegex = /\.rpc\((['"])([^'"]+)\1/g;
  let rpcMatch;
  while ((rpcMatch = rpcRegex.exec(source))) {
    const rpcName = rpcMatch[2];
    if (!scan.rpcs[rpcName]) {
      scan.rpcs[rpcName] = [];
    }
    scan.rpcs[rpcName].push({
      file,
      line: lineFromIndex(source, rpcMatch.index)
    });
  }

  scan.sources[file] = source;
}

function scanBackendSource() {
  if (sourceScanCache && (Date.now() - sourceScanCache.timestamp) < 10_000) {
    return sourceScanCache.value;
  }

  const files = SOURCE_SCAN_PATHS.flatMap((target) => collectSourceFiles(target, []));
  const scan = {
    tables: {},
    rpcs: {},
    sources: {}
  };

  for (const filePath of files) {
    scanSourceFile(filePath, scan);
  }

  sourceScanCache = {
    timestamp: Date.now(),
    value: scan
  };
  return scan;
}

function getSource(scan, relativePath) {
  return scan.sources[relativePath] || '';
}

function hasPattern(source, pattern) {
  return Boolean(source && pattern.test(source));
}

function summarizeRefs(refs = [], limit = 5) {
  return refs.slice(0, limit).map((ref) => ({
    file: ref.file,
    line: ref.line,
    operation: ref.operation || null
  }));
}

function hasMaterialWrites(refs = []) {
  return refs.some((ref) => ['insert', 'update', 'upsert'].includes(ref.operation));
}

async function countRows(supabase, table) {
  if (!supabase?.from) {
    return {
      available: false,
      count: null,
      error: {
        code: 'SUPABASE_UNAVAILABLE',
        message: 'Supabase client unavailable'
      }
    };
  }

  try {
    const { count, error } = await supabase
      .from(table)
      .select('*', { head: true, count: 'exact' })
      .limit(1);

    return {
      available: !error || !isMissingSchemaError(error),
      count: error ? null : Number(count || 0),
      error: error ? serializeSupabaseError(error) : null
    };
  } catch (error) {
    return {
      available: false,
      count: null,
      error: serializeSupabaseError(error)
    };
  }
}

async function countRecentRows(supabase, table, timeColumns, sinceIso) {
  if (!supabase?.from) {
    return {
      available: false,
      count: null,
      time_column: null,
      error: {
        code: 'SUPABASE_UNAVAILABLE',
        message: 'Supabase client unavailable'
      }
    };
  }

  let lastError = null;
  for (const timeColumn of timeColumns || []) {
    try {
      const { count, error } = await supabase
        .from(table)
        .select('*', { head: true, count: 'exact' })
        .gte(timeColumn, sinceIso);

      if (!error) {
        return {
          available: true,
          count: Number(count || 0),
          time_column: timeColumn,
          error: null
        };
      }

      lastError = serializeSupabaseError(error);
      if (!isMissingSchemaError(error)) {
        return {
          available: false,
          count: null,
          time_column: timeColumn,
          error: lastError
        };
      }
    } catch (error) {
      return {
        available: false,
        count: null,
        time_column: timeColumn,
        error: serializeSupabaseError(error)
      };
    }
  }

  return {
    available: false,
    count: null,
    time_column: null,
    error: lastError || {
      code: 'NO_TIME_COLUMN',
      message: `No compatible time column available for ${table}`
    }
  };
}

async function fetchSampleRows(supabase, table, config) {
  if (!supabase?.from || !config?.sampleColumns?.length) {
    return { available: false, rows: [], order_column: null, error: null };
  }

  const orderCandidates = [...(config.timeColumns || []), 'updated_at', 'created_at'];
  const selectColumns = config.sampleColumns.join(', ');
  let lastError = null;

  for (const orderColumn of orderCandidates) {
    try {
      const { data, error } = await supabase
        .from(table)
        .select(selectColumns)
        .order(orderColumn, { ascending: false, nullsFirst: false })
        .limit(25);

      if (!error) {
        return {
          available: true,
          rows: Array.isArray(data) ? data : [],
          order_column: orderColumn,
          error: null
        };
      }

      lastError = serializeSupabaseError(error);
      if (!isMissingSchemaError(error)) {
        return {
          available: false,
          rows: [],
          order_column: orderColumn,
          error: lastError
        };
      }
    } catch (error) {
      return {
        available: false,
        rows: [],
        order_column: orderColumn,
        error: serializeSupabaseError(error)
      };
    }
  }

  return {
    available: false,
    rows: [],
    order_column: null,
    error: lastError
  };
}

function analyzeNullHeavyColumns(rows, config) {
  if (!Array.isArray(rows) || !rows.length) {
    return {
      sample_size: 0,
      expected: config?.expectedNullHeavyColumns || [],
      suspicious: []
    };
  }

  const suspicious = [];
  for (const column of config.criticalColumns || []) {
    const nullCount = rows.filter((row) => row[column] === null || row[column] === undefined).length;
    if (nullCount > 0) {
      suspicious.push({
        column,
        null_rows: nullCount
      });
    }
  }

  const expected = [];
  for (const column of config.expectedNullHeavyColumns || []) {
    const nullCount = rows.filter((row) => row[column] === null || row[column] === undefined).length;
    if (nullCount > 0) {
      expected.push({
        column,
        null_rows: nullCount
      });
    }
  }

  return {
    sample_size: rows.length,
    expected,
    suspicious
  };
}

async function inspectQuotaSummaryTrigger() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    return {
      exists: false,
      verification_method: 'missing_env',
      error: {
        code: 'MISSING_ENV',
        message: 'SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing'
      }
    };
  }

  try {
    const url = new URL(`${supabaseUrl}/rest/v1/triggers`);
    url.searchParams.set('select', 'trigger_name,event_object_table');
    url.searchParams.set('trigger_name', 'eq.trg_update_quota_summary');

    const response = await fetch(url.toString(), {
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        'Accept-Profile': 'information_schema'
      }
    });

    if (!response.ok) {
      return {
        exists: false,
        verification_method: 'information_schema_http_failed',
        error: {
          code: `HTTP_${response.status}`,
          message: await response.text()
        }
      };
    }

    const rows = await response.json().catch(() => []);
    return {
      exists: Array.isArray(rows) && rows.length > 0,
      verification_method: 'information_schema_http',
      error: null
    };
  } catch (error) {
    return {
      exists: false,
      verification_method: 'information_schema_http_failed',
      error: serializeSupabaseError(error)
    };
  }
}

function classifyTable(table, summary, scan, triggerCheck) {
  const refs = scan.tables[table] || { writes: [], reads: [] };
  const hasDirectWrites = hasMaterialWrites(refs.writes || []);
  const hasReads = refs.reads.length > 0;

  if (table === 'quota_summaries') {
    return triggerCheck.exists || hasReads ? 'ACTIVE' : CLASSIFICATION_HINTS[table];
  }

  if (table === 'dashboard_sessions') {
    return Number(summary.total_count || 0) === 0 ? 'EXPECTED_EMPTY' : 'ACTIVE';
  }

  if (table === 'debug_logs') {
    return hasDirectWrites ? 'ACTIVE' : 'DEAD';
  }

  if (table === 'subscriptions') {
    if (hasDirectWrites) {
      return 'ACTIVE';
    }
    return hasReads ? 'LEGACY' : 'DEAD';
  }

  if (table === 'v_license_quota_current') {
    return 'LEGACY';
  }

  if (hasDirectWrites) {
    return 'ACTIVE';
  }

  if (hasReads) {
    return 'LEGACY';
  }

  return CLASSIFICATION_HINTS[table] || 'DEAD';
}

function deriveBackendWriteStatus(table, scan, triggerCheck) {
  const refs = scan.tables[table] || { writes: [], reads: [] };

  if (table === 'quota_summaries') {
    return {
      backend_writes_currently: Boolean(triggerCheck.exists || (scan.tables.usage_logs?.writes || []).length),
      write_mode: triggerCheck.exists ? 'indirect_trigger' : 'indirect_expected'
    };
  }

  if (table === 'v_license_quota_current') {
    return {
      backend_writes_currently: false,
      write_mode: 'read_only_view'
    };
  }

  return {
    backend_writes_currently: hasMaterialWrites(refs.writes || []),
    write_mode: hasMaterialWrites(refs.writes || []) ? 'direct' : 'none'
  };
}

function buildWritePaths(scan) {
  const authSource = getSource(scan, 'fresh-stack/routes/auth.js');
  const siteQuotaSource = getSource(scan, 'fresh-stack/services/siteQuota.js');
  const altTextSource = getSource(scan, 'fresh-stack/routes/altText.js');
  const bulkSource = getSource(scan, 'fresh-stack/services/bulkAltTextProcessor.js');
  const billingSource = getSource(scan, 'fresh-stack/routes/billing.js');

  const registerUsesSiteAttach = hasPattern(
    authSource,
    /router\.post\('\/register'[\s\S]{0,12000}attachSiteContextForAccount/
  );
  const loginUsesSiteAttach = hasPattern(
    authSource,
    /router\.post\('\/login'[\s\S]{0,12000}attachSiteContextForAccount/
  );

  return {
    signup_creates_license: hasPattern(
      authSource,
      /router\.post\('\/register'[\s\S]{0,12000}\.from\('licenses'\)[\s\S]{0,2000}\.insert\(/
    ),
    signup_creates_site: registerUsesSiteAttach
      && hasPattern(siteQuotaSource, /async function createCanonicalSite[\s\S]{0,2500}\.from\('sites'\)[\s\S]{0,500}\.insert\(/),
    signup_creates_site_membership: registerUsesSiteAttach
      && hasPattern(siteQuotaSource, /async function ensureSiteMembership[\s\S]{0,4000}\.from\('site_memberships'\)[\s\S]{0,1000}\.(insert|update)\(/),
    login_updates_site: loginUsesSiteAttach
      && hasPattern(siteQuotaSource, /async function reconcileResolvedSite[\s\S]{0,3500}\.from\('sites'\)[\s\S]{0,800}\.update\(/),
    generation_writes_usage_logs: hasPattern(altTextSource, /recordUsage\(/)
      || hasPattern(bulkSource, /recordUsage\(/),
    generation_writes_trial_usage: hasPattern(altTextSource, /recordLegacyTrialUsage\(/),
    billing_writes_subscriptions: (scan.tables.subscriptions?.writes || []).length > 0,
    billing_writes_licenses: (scan.tables.licenses?.writes || []).some((ref) => ref.file.includes('billing') || ref.file.includes('siteQuota'))
  };
}

function buildWritePathHealth(writePaths, scan, tableHealth) {
  const health = {};
  const recent = (table) => Number(tableHealth[table]?.last_7d_count || 0);

  health.signup_creates_license = {
    code_path_present: writePaths.signup_creates_license,
    recent_table_evidence: recent('licenses') > 0,
    evidence_tables: ['licenses'],
    refs: summarizeRefs(scan.tables.licenses?.writes || [])
  };

  health.signup_creates_site = {
    code_path_present: writePaths.signup_creates_site,
    recent_table_evidence: recent('sites') > 0,
    evidence_tables: ['sites'],
    refs: summarizeRefs(scan.tables.sites?.writes || [])
  };

  health.signup_creates_site_membership = {
    code_path_present: writePaths.signup_creates_site_membership,
    recent_table_evidence: (scan.tables.site_memberships?.writes || []).length > 0,
    evidence_tables: ['site_memberships'],
    refs: summarizeRefs(scan.tables.site_memberships?.writes || [])
  };

  health.login_updates_site = {
    code_path_present: writePaths.login_updates_site,
    recent_table_evidence: recent('sites') > 0,
    evidence_tables: ['sites'],
    refs: summarizeRefs(scan.tables.sites?.writes || [])
  };

  health.generation_writes_usage_logs = {
    code_path_present: writePaths.generation_writes_usage_logs,
    recent_table_evidence: recent('usage_logs') > 0,
    evidence_tables: ['usage_logs'],
    refs: summarizeRefs(scan.tables.usage_logs?.writes || [])
  };

  health.generation_writes_trial_usage = {
    code_path_present: writePaths.generation_writes_trial_usage,
    recent_table_evidence: recent('trial_usage') > 0,
    evidence_tables: ['trial_usage'],
    refs: summarizeRefs(scan.tables.trial_usage?.writes || [])
  };

  health.billing_writes_subscriptions = {
    code_path_present: writePaths.billing_writes_subscriptions,
    recent_table_evidence: recent('subscriptions') > 0,
    evidence_tables: ['subscriptions'],
    refs: summarizeRefs(scan.tables.subscriptions?.writes || [])
  };

  health.billing_writes_licenses = {
    code_path_present: writePaths.billing_writes_licenses,
    recent_table_evidence: recent('licenses') > 0,
    evidence_tables: ['licenses'],
    refs: summarizeRefs((scan.tables.licenses?.writes || []).filter((ref) => ref.file.includes('billing') || ref.file.includes('siteQuota')))
  };

  return health;
}

function buildClassificationSummary(tableHealth = {}) {
  const summary = {
    active: [],
    legacy: [],
    dead: [],
    expected_empty: []
  };

  for (const [table, info] of Object.entries(tableHealth)) {
    const classification = info?.classification;
    if (classification === 'ACTIVE') {
      summary.active.push(table);
    } else if (classification === 'LEGACY') {
      summary.legacy.push(table);
    } else if (classification === 'DEAD') {
      summary.dead.push(table);
    } else if (classification === 'EXPECTED_EMPTY') {
      summary.expected_empty.push(table);
    }
  }

  for (const key of Object.keys(summary)) {
    summary[key].sort();
  }

  return summary;
}

function buildSuspicions({
  environment,
  schema,
  recentActivity,
  writePaths,
  writePathHealth,
  tableHealth
}) {
  const suspicions = [];

  if (recentActivity.licenses_last_7d > 0 && recentActivity.sites_last_7d === 0 && writePaths.signup_creates_site) {
    suspicions.push('Recent licenses exist but recent sites do not. Register/login site linking is present in code yet has no recent table evidence.');
  }

  if (recentActivity.usage_logs_last_7d > 0
    && schema.has_v2_tables.generation_requests
    && schema.has_v2_tables.usage_events
    && Number(tableHealth.generation_requests?.last_7d_count || 0) === 0) {
    suspicions.push('usage_logs is active while generation_requests has no recent rows. Generation traffic may still be falling back to legacy accounting.');
  }

  if (recentActivity.trial_usage_last_7d > 0
    && schema.has_v2_tables.site_trials
    && Number(tableHealth.site_trials?.last_7d_count || 0) === 0) {
    suspicions.push('trial_usage is active while site_trials has no recent rows. Anonymous trial traffic appears to be bypassing the V2 trial ledger.');
  }

  if (!writePaths.billing_writes_subscriptions && (scanBackendSource().tables.subscriptions?.reads || []).length > 0) {
    suspicions.push('subscriptions is still read by billing routes, but no live backend write path to subscriptions exists.');
  }

  if ((scanBackendSource().rpcs.bbai_merge_sites || []).length === 0) {
    suspicions.push('bbai_merge_sites has no live runtime caller in backend JS. Treat it as an optional operator/admin merge tool, not a required V2 request-path RPC.');
  }

  if (tableHealth.debug_logs?.classification === 'DEAD') {
    const hasDebugLogReads = (scanBackendSource().tables.debug_logs?.reads || []).length > 0;
    suspicions.push(
      hasDebugLogReads
        ? 'debug_logs has no write path in the backend. Dashboard troubleshooting data will stay empty until a writer is added.'
        : 'debug_logs has no live runtime producer or consumer. The table is retained only for compatibility and admin cleanup.'
    );
  }

  if (tableHealth.dashboard_sessions?.classification === 'EXPECTED_EMPTY'
    && Number(tableHealth.dashboard_sessions?.total_count || 0) === 0) {
    suspicions.push('dashboard_sessions is empty. That is acceptable if the standalone dashboard login path is unused.');
  }

  if (!environment.has_service_role_key) {
    suspicions.push('SUPABASE_SERVICE_ROLE_KEY is not configured. Diagnostics and privileged writes may be incomplete.');
  }

  if (!schema.trigger_checks.trg_update_quota_summary.exists) {
    suspicions.push('trg_update_quota_summary could not be verified. quota_summaries may not reflect usage_logs inserts.');
  }

  for (const [pathName, health] of Object.entries(writePathHealth)) {
    if (health.code_path_present && health.recent_table_evidence === false && ['signup_creates_license', 'signup_creates_site', 'generation_writes_usage_logs', 'generation_writes_trial_usage'].includes(pathName)) {
      suspicions.push(`${pathName} exists in code but has no recent table evidence.`);
    }
  }

  return [...new Set(suspicions)];
}

async function buildTableHealthSummary(supabase, scan, triggerCheck, sinceIso) {
  const tableHealth = {};

  for (const [table, config] of Object.entries(TABLE_HEALTH_CONFIG)) {
    const total = await countRows(supabase, table);
    const recent = await countRecentRows(supabase, table, config.timeColumns, sinceIso);
    const sample = await fetchSampleRows(supabase, table, config);
    const nullHeavy = analyzeNullHeavyColumns(sample.rows, config);
    const writeStatus = deriveBackendWriteStatus(table, scan, triggerCheck);

    const summary = {
      available: total.available || recent.available || sample.available,
      total_count: total.count,
      last_7d_count: recent.count,
      last_7d_time_column: recent.time_column,
      backend_writes_currently: writeStatus.backend_writes_currently,
      write_mode: writeStatus.write_mode,
      read_refs: summarizeRefs(scan.tables[table]?.reads || []),
      write_refs: summarizeRefs(scan.tables[table]?.writes || []),
      null_heavy_columns: nullHeavy,
      errors: {
        total_count: total.error,
        last_7d_count: recent.error,
        sample: sample.error
      }
    };

    summary.classification = classifyTable(table, summary, scan, triggerCheck);
    summary.appears_legacy = summary.classification === 'LEGACY';
    summary.appears_dead = summary.classification === 'DEAD';
    summary.expected_empty = summary.classification === 'EXPECTED_EMPTY';
    tableHealth[table] = summary;
  }

  return tableHealth;
}

async function buildDataIntegrityDiagnostics(supabase, { days = 7, runtimeIdentity = null } = {}) {
  const windowDays = Number(days) || 7;
  const checkedAt = new Date().toISOString();
  const sinceIso = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();
  const scan = scanBackendSource();
  const v2Schema = await inspectV2Schema(supabase);
  let triggerCheck = await inspectQuotaSummaryTrigger();
  let tableHealth = await buildTableHealthSummary(supabase, scan, triggerCheck, sinceIso);
  if (
    !triggerCheck.exists
    && Number(tableHealth.usage_logs?.last_7d_count || 0) > 0
    && Number(tableHealth.quota_summaries?.total_count || 0) > 0
  ) {
    triggerCheck = {
      exists: true,
      verification_method: 'inferred_from_recent_usage_logs_and_quota_summaries',
      error: triggerCheck.error
    };
    tableHealth = await buildTableHealthSummary(supabase, scan, triggerCheck, sinceIso);
  }
  const writePaths = buildWritePaths(scan);
  const writePathHealth = buildWritePathHealth(writePaths, scan, tableHealth);
  const effectiveRuntimeIdentity = runtimeIdentity || getRuntimeIdentity();

  const environment = {
    node_env: process.env.NODE_ENV || 'development',
    supabase_url_host: getSupabaseUrlHost(),
    has_service_role_key: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
    loops_enabled: Boolean(process.env.LOOPS_API_KEY),
    stripe_enabled: Boolean(process.env.STRIPE_SECRET_KEY)
  };

  const schema = {
    has_v2_tables: {
      site_subscriptions: Boolean(v2Schema.tables?.site_subscriptions?.available),
      site_quotas: Boolean(v2Schema.tables?.site_quotas?.available),
      site_trials: Boolean(v2Schema.tables?.site_trials?.available),
      generation_requests: Boolean(v2Schema.tables?.generation_requests?.available),
      usage_events: Boolean(v2Schema.tables?.usage_events?.available),
      site_audit_logs: Boolean(v2Schema.tables?.site_audit_logs?.available),
      plans: Boolean(v2Schema.tables?.plans?.available),
      site_memberships: Boolean(v2Schema.tables?.site_memberships?.available)
    },
    has_v2_rpcs: {
      bbai_reserve_site_generation: Boolean(v2Schema.functions?.bbai_reserve_site_generation?.available),
      bbai_finalize_site_generation: Boolean(v2Schema.functions?.bbai_finalize_site_generation?.available),
      bbai_apply_site_billing_event: Boolean(v2Schema.functions?.bbai_apply_site_billing_event?.available)
    },
    optional_admin_rpcs: {
      bbai_merge_sites: Boolean(v2Schema.optional_functions?.bbai_merge_sites?.available)
    },
    has_trigger_trg_update_quota_summary: Boolean(triggerCheck.exists),
    trigger_checks: {
      trg_update_quota_summary: triggerCheck
    }
  };

  const recentActivity = {
    licenses_last_7d: Number(tableHealth.licenses?.last_7d_count || 0),
    sites_last_7d: Number(tableHealth.sites?.last_7d_count || 0),
    trial_usage_last_7d: Number(tableHealth.trial_usage?.last_7d_count || 0),
    usage_logs_last_7d: Number(tableHealth.usage_logs?.last_7d_count || 0),
    subscriptions_last_7d: Number(tableHealth.subscriptions?.last_7d_count || 0),
    dashboard_sessions_last_7d: Number(tableHealth.dashboard_sessions?.last_7d_count || 0),
    debug_logs_last_7d: Number(tableHealth.debug_logs?.last_7d_count || 0)
  };

  const supportingTables = {
    quota_summaries_last_7d: Number(tableHealth.quota_summaries?.last_7d_count || 0),
    generation_requests_last_7d: Number(tableHealth.generation_requests?.last_7d_count || 0),
    usage_events_last_7d: Number(tableHealth.usage_events?.last_7d_count || 0),
    site_trials_last_7d: Number(tableHealth.site_trials?.last_7d_count || 0),
    site_subscriptions_last_7d: Number(tableHealth.site_subscriptions?.last_7d_count || 0),
    site_memberships_write_refs: summarizeRefs(scan.tables.site_memberships?.writes || [])
  };

  const suspicions = buildSuspicions({
    environment,
    schema,
    recentActivity,
    writePaths,
    writePathHealth,
    tableHealth
  });

  const recentWarningsErrors = typeof logger.getRecentEntries === 'function'
    ? logger.getRecentEntries({ levels: ['warn', 'error'], limit: 15 })
    : [];

  return {
    checked_at: checkedAt,
    window_days: windowDays,
    window_start: sinceIso,
    runtime: effectiveRuntimeIdentity,
    environment,
    schema,
    recent_activity: recentActivity,
    classification: buildClassificationSummary(tableHealth),
    write_paths: writePaths,
    write_path_health: writePathHealth,
    table_health: tableHealth,
    supporting_tables: supportingTables,
    code_scan: {
      tables: Object.fromEntries(
        Object.entries(scan.tables).map(([table, refs]) => [
          table,
          {
            writes: summarizeRefs(refs.writes || []),
            reads: summarizeRefs(refs.reads || [])
          }
        ])
      ),
      rpcs: Object.fromEntries(
        Object.entries(scan.rpcs).map(([rpcName, refs]) => [rpcName, refs.slice(0, 5)])
      )
    },
    recent_log_summary: recentWarningsErrors,
    recent_warnings_errors: recentWarningsErrors,
    suspicions
  };
}

module.exports = {
  buildDataIntegrityDiagnostics,
  getSupabaseUrlHost,
  getRuntimeIdentity,
  logRuntimeIdentityStartup,
  logSupabaseTargetStartup
};
