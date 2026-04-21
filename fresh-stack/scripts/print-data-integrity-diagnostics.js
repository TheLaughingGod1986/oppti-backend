#!/usr/bin/env node

const { buildDataIntegrityDiagnostics } = require('../services/dataIntegrityDiagnostics');

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

function loadSupabaseClient() {
  const supabaseClient = require('../../db/supabase-client');
  return supabaseClient.supabase || supabaseClient;
}

async function runDataIntegrityDiagnosticsCli({
  argv = process.argv.slice(2),
  stdout = process.stdout,
  stderr = process.stderr,
  supabase = null,
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

    const diagnostics = await diagnosticsBuilder(supabase || loadSupabaseClient(), {
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
  getUsageText,
  loadSupabaseClient,
  parseCliArgs,
  runDataIntegrityDiagnosticsCli
};
