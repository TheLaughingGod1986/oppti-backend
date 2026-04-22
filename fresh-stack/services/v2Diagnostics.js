const logger = require('../lib/logger');
const { isMissingSchemaError, serializeSupabaseError } = require('../lib/supabaseErrors');

const REQUIRED_V2_FUNCTIONS = [
  {
    name: 'bbai_reserve_site_generation',
    args: {
      p_site_id: null
    }
  },
  {
    name: 'bbai_finalize_site_generation',
    args: {
      p_generation_request_id: null,
      p_success: false,
      p_final_metadata: {}
    }
  },
  {
    name: 'bbai_apply_site_billing_event',
    args: {
      p_site_id: null,
      p_stripe_event_id: null,
      p_plan_id: 'free',
      p_purchase_type: 'diagnostic',
      p_metadata: {}
    }
  }
];

// Manual site merges are not part of the live request-path contract.
// Keep probing them for operator visibility, but do not let their absence
// force the backend into V2 fallback mode.
const OPTIONAL_ADMIN_FUNCTIONS = [
  {
    name: 'bbai_merge_sites',
    args: {
      p_source_site_id: null,
      p_target_site_id: null,
      p_actor_user_id: null,
      p_reason: 'diagnostic'
    }
  }
];

const REQUIRED_V2_TABLES = [
  'plans',
  'site_memberships',
  'site_subscriptions',
  'site_quotas',
  'site_trials',
  'generation_requests',
  'usage_events',
  'site_audit_logs'
];

const DIAGNOSTIC_TABLE_WINDOWS = {
  sites: ['first_seen_at', 'activated_at', 'updated_at'],
  trial_usage: ['created_at'],
  usage_logs: ['created_at'],
  generation_requests: ['created_at']
};

async function probeV2Function(supabase, probe) {
  if (!supabase?.rpc) {
    return {
      available: false,
      error: {
        code: 'SUPABASE_RPC_UNAVAILABLE',
        message: 'Supabase RPC client unavailable'
      }
    };
  }

  try {
    const { data, error } = await supabase.rpc(probe.name, probe.args);
    const available = !error || !isMissingSchemaError(error);
    return {
      available,
      result_code: data?.code || null,
      error: error ? serializeSupabaseError(error) : null
    };
  } catch (error) {
    return {
      available: false,
      error: serializeSupabaseError(error)
    };
  }
}

async function probeV2Table(supabase, table) {
  if (!supabase?.from) {
    return {
      available: false,
      error: {
        code: 'SUPABASE_UNAVAILABLE',
        message: 'Supabase client unavailable'
      }
    };
  }

  try {
    const { error } = await supabase
      .from(table)
      .select('id', { head: true, count: 'exact' })
      .limit(1);

    return {
      available: !error || !isMissingSchemaError(error),
      error: error ? serializeSupabaseError(error) : null
    };
  } catch (error) {
    return {
      available: false,
      error: serializeSupabaseError(error)
    };
  }
}

async function inspectV2Schema(supabase) {
  const checked_at = new Date().toISOString();

  if (!supabase) {
    return {
      checked_at,
      available: false,
      fallback_mode: true,
      missing_functions: REQUIRED_V2_FUNCTIONS.map((probe) => probe.name),
      missing_optional_functions: OPTIONAL_ADMIN_FUNCTIONS.map((probe) => probe.name),
      missing_tables: [...REQUIRED_V2_TABLES],
      functions: {},
      optional_functions: {},
      tables: {},
      error: {
        code: 'SUPABASE_UNAVAILABLE',
        message: 'Supabase client unavailable'
      }
    };
  }

  const functions = {};
  for (const probe of REQUIRED_V2_FUNCTIONS) {
    functions[probe.name] = await probeV2Function(supabase, probe);
  }

  const optional_functions = {};
  for (const probe of OPTIONAL_ADMIN_FUNCTIONS) {
    optional_functions[probe.name] = await probeV2Function(supabase, probe);
  }

  const tables = {};
  for (const table of REQUIRED_V2_TABLES) {
    tables[table] = await probeV2Table(supabase, table);
  }

  const missing_functions = Object.entries(functions)
    .filter(([, status]) => !status.available)
    .map(([name]) => name);
  const missing_tables = Object.entries(tables)
    .filter(([, status]) => !status.available)
    .map(([name]) => name);
  const missing_optional_functions = Object.entries(optional_functions)
    .filter(([, status]) => !status.available)
    .map(([name]) => name);

  return {
    checked_at,
    available: missing_functions.length === 0 && missing_tables.length === 0,
    fallback_mode: missing_functions.length > 0 || missing_tables.length > 0,
    missing_functions,
    missing_optional_functions,
    missing_tables,
    functions,
    optional_functions,
    tables
  };
}

function logV2SchemaStartupStatus(report) {
  if (report.available) {
    logger.info('[V2_SCHEMA] V2 quota schema verified at startup', {
      checked_at: report.checked_at
    });
    return report;
  }

  logger.error('==========================================================');
  logger.error('[V2_SCHEMA_CRITICAL] V2 schema is not deployed; backend is running on legacy fallback', {
    checked_at: report.checked_at,
    missing_functions: report.missing_functions,
    missing_tables: report.missing_tables
  });
  logger.error('[V2_SCHEMA_CRITICAL] Apply database migrations before expecting V2 site/quota flow to work', {
    required_migrations: [
      '008_site_owned_quota_model.sql',
      '009_anonymous_trial_observability.sql'
    ]
  });
  logger.error('==========================================================');
  return report;
}

async function countRecentRows(supabase, table, timeColumns, sinceIso) {
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

  let lastError = null;
  for (const timeColumn of timeColumns) {
    try {
      const { count, error } = await supabase
        .from(table)
        .select('id', { head: true, count: 'exact' })
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
      lastError = serializeSupabaseError(error);
      return {
        available: false,
        count: null,
        error: lastError
      };
    }
  }

  return {
    available: false,
    count: null,
    error: lastError || {
      code: 'SCHEMA_UNAVAILABLE',
      message: `No compatible timestamp column available for ${table}`
    }
  };
}

async function getPipelineDiagnostics(supabase, { days = 7 } = {}) {
  const checked_at = new Date().toISOString();
  const since = new Date(Date.now() - (Number(days) || 7) * 24 * 60 * 60 * 1000).toISOString();
  const v2_schema = await inspectV2Schema(supabase);

  const counts = {};
  for (const [table, timeColumns] of Object.entries(DIAGNOSTIC_TABLE_WINDOWS)) {
    counts[table] = await countRecentRows(supabase, table, timeColumns, since);
  }

  return {
    checked_at,
    window_days: Number(days) || 7,
    window_start: since,
    v2_schema,
    counts_last_7d: counts,
    recent_log_summary: typeof logger.getRecentEntries === 'function'
      ? logger.getRecentEntries({ levels: ['warn', 'error'], limit: 10 })
      : []
  };
}

module.exports = {
  REQUIRED_V2_FUNCTIONS,
  REQUIRED_V2_TABLES,
  getPipelineDiagnostics,
  inspectV2Schema,
  logV2SchemaStartupStatus
};
