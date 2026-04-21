#!/usr/bin/env node

const { buildDataIntegrityDiagnostics } = require('../services/dataIntegrityDiagnostics');
const REQUIRED_OPERATOR_ENV_VARS = [
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY'
];

function parseCliArgs(argv = []) {
  const args = Array.isArray(argv) ? [...argv] : [];
  const options = {
    pretty: false,
    days: 7
  };

  while (args.length > 0) {
    const arg = args.shift();

    if (arg === '--pretty') {
      options.pretty = true;
      continue;
    }

    if (arg === '--days') {
      const value = Number(args.shift());
      if (!Number.isFinite(value) || value <= 0) {
        throw new Error('Invalid value for --days; expected a positive number');
      }
      options.days = value;
      continue;
    }

    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function getUsageText() {
  return [
    'Usage: node fresh-stack/scripts/print-data-integrity-diagnostics.js [--pretty] [--days N]',
    '',
    'Runs the same internal diagnostics builder used by GET /admin/diagnostics/data-integrity',
    'and prints the diagnostics object as JSON to stdout.'
  ].join('\n');
}

function getMissingRequiredEnv(env = process.env) {
  return REQUIRED_OPERATOR_ENV_VARS.filter((key) => {
    const value = env[key];
    return value === undefined || value === null || value === '';
  });
}

function buildMissingEnvErrorPayload(missing) {
  return {
    success: false,
    error: 'MISSING_REQUIRED_ENV',
    missing,
    message: 'Run this command inside the backend runtime environment (e.g. Render shell) or load the backend env vars first.',
    operator_hints: [
      'printenv | grep SUPABASE',
      'echo $SUPABASE_URL'
    ]
  };
}

function loadSupabaseClient() {
  const supabaseClient = require('../../db/supabase-client');
  return supabaseClient.supabase || supabaseClient;
}

async function runDataIntegrityDiagnosticsCli({
  argv = process.argv.slice(2),
  stdout = process.stdout,
  stderr = process.stderr,
  env = process.env,
  supabase = null,
  supabaseLoader = loadSupabaseClient,
  diagnosticsBuilder = buildDataIntegrityDiagnostics,
  exit = (code) => {
    process.exitCode = code;
  }
} = {}) {
  try {
    const options = parseCliArgs(argv);

    if (options.help) {
      stdout.write(`${getUsageText()}\n`);
      return null;
    }

    const missing = !supabase ? getMissingRequiredEnv(env) : [];
    if (missing.length > 0) {
      const payload = buildMissingEnvErrorPayload(missing);
      stderr.write(`${JSON.stringify(payload)}\n`);
      exit(1);
      return null;
    }

    const diagnostics = await diagnosticsBuilder(supabase || supabaseLoader(), {
      days: options.days
    });

    stdout.write(`${JSON.stringify(diagnostics, null, options.pretty ? 2 : 0)}\n`);
    return diagnostics;
  } catch (error) {
    stderr.write(`${JSON.stringify({
      success: false,
      error: 'DATA_INTEGRITY_DIAGNOSTICS_CLI_FAILED',
      message: error.message
    })}\n`);
    exit(1);
    return null;
  }
}

if (require.main === module) {
  runDataIntegrityDiagnosticsCli();
}

module.exports = {
  buildMissingEnvErrorPayload,
  getUsageText,
  getMissingRequiredEnv,
  loadSupabaseClient,
  parseCliArgs,
  REQUIRED_OPERATOR_ENV_VARS,
  runDataIntegrityDiagnosticsCli
};
