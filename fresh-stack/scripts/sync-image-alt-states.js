#!/usr/bin/env node

const fs = require('fs/promises');
const {
  buildMissingEnvErrorPayload,
  getMissingRequiredEnv,
  loadSupabaseClient
} = require('./print-data-integrity-diagnostics');
const {
  getImageAltStateLedgerCoverage,
  resolveImageAltStateSyncTarget,
  syncImageAltStates
} = require('../services/imageAltState');

function parseSyncCliArgs(argv = []) {
  const args = Array.isArray(argv) ? [...argv] : [];
  const options = {
    pretty: false,
    scope: 'full_site',
    allowDowngrade: false,
    input: null,
    siteId: null,
    siteHash: null,
    licenseKey: null,
    siteUrl: null,
    installUuid: null,
    siteFingerprint: null
  };

  while (args.length > 0) {
    const arg = args.shift();

    if (arg === '--pretty') {
      options.pretty = true;
      continue;
    }

    if (arg === '--input') {
      options.input = args.shift() || null;
      continue;
    }

    if (arg === '--site-id') {
      options.siteId = args.shift() || null;
      continue;
    }

    if (arg === '--site-hash') {
      options.siteHash = args.shift() || null;
      continue;
    }

    if (arg === '--license-key') {
      options.licenseKey = args.shift() || null;
      continue;
    }

    if (arg === '--site-url') {
      options.siteUrl = args.shift() || null;
      continue;
    }

    if (arg === '--install-uuid') {
      options.installUuid = args.shift() || null;
      continue;
    }

    if (arg === '--site-fingerprint') {
      options.siteFingerprint = args.shift() || null;
      continue;
    }

    if (arg === '--scope') {
      const value = args.shift();
      if (!['full_site', 'partial'].includes(value)) {
        throw new Error('Invalid value for --scope; expected full_site or partial');
      }
      options.scope = value;
      continue;
    }

    if (arg === '--allow-downgrade') {
      options.allowDowngrade = true;
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
    'Usage: node fresh-stack/scripts/sync-image-alt-states.js --site-id <uuid> [--input inventory.json] [--pretty]',
    '   or: node fresh-stack/scripts/sync-image-alt-states.js --site-hash <hash> --input inventory.json --pretty',
    '   or: cat inventory.json | node fresh-stack/scripts/sync-image-alt-states.js --license-key <key> --pretty',
    '',
    'Input JSON can be either:',
    '- a plain array of image objects',
    '- or an object like { "images": [...], "scope": "full_site" }',
    '',
    'Per-image state defaults to MISSING when current_state is omitted.',
    'Existing APPROVED / NEEDS_REVIEW rows are preserved unless --allow-downgrade',
    'or force_state=true is explicitly provided in the input payload.'
  ].join('\n');
}

function hasTargetSelector(options = {}) {
  return Boolean(
    options.siteId
      || options.siteHash
      || options.licenseKey
      || options.siteUrl
      || options.installUuid
      || options.siteFingerprint
  );
}

function buildCliErrorPayload(error, message, extras = {}) {
  return {
    success: false,
    error,
    message,
    ...extras
  };
}

function normalizeSyncInputPayload(value) {
  if (Array.isArray(value)) {
    return {
      images: value,
      scope: null,
      allowDowngrade: false
    };
  }

  if (value && typeof value === 'object' && Array.isArray(value.images)) {
    return {
      images: value.images,
      scope: value.scope || null,
      allowDowngrade: Boolean(value.allow_downgrade || value.allowDowngrade)
    };
  }

  throw new Error('Sync input must be a JSON array or an object with an images array');
}

async function readSyncInput({ inputPath = null, stdin = process.stdin } = {}) {
  if (inputPath) {
    return fs.readFile(inputPath, 'utf8');
  }

  if (stdin && stdin.isTTY === false) {
    let output = '';
    for await (const chunk of stdin) {
      output += chunk;
    }
    return output;
  }

  return null;
}

async function runImageAltStateSyncCli({
  argv = process.argv.slice(2),
  stdout = process.stdout,
  stderr = process.stderr,
  stdin = process.stdin,
  env = process.env,
  supabase = null,
  supabaseLoader = loadSupabaseClient,
  siteResolver = resolveImageAltStateSyncTarget,
  coverageResolver = getImageAltStateLedgerCoverage,
  syncRunner = syncImageAltStates,
  exit = (code) => {
    process.exitCode = code;
  }
} = {}) {
  try {
    const options = parseSyncCliArgs(argv);

    if (options.help) {
      stdout.write(`${getUsageText()}\n`);
      return null;
    }

    const missing = !supabase ? getMissingRequiredEnv(env) : [];
    if (missing.length > 0) {
      stderr.write(`${JSON.stringify(buildMissingEnvErrorPayload(missing))}\n`);
      exit(1);
      return null;
    }

    if (!hasTargetSelector(options)) {
      stderr.write(`${JSON.stringify(buildCliErrorPayload(
        'MISSING_SITE_SELECTOR',
        'Provide --site-id, --site-hash, --license-key, or another site selector before syncing.'
      ))}\n`);
      exit(1);
      return null;
    }

    const inputText = await readSyncInput({
      inputPath: options.input,
      stdin
    });

    if (!inputText || !String(inputText).trim()) {
      stderr.write(`${JSON.stringify(buildCliErrorPayload(
        'MISSING_SYNC_INPUT',
        'Provide a JSON inventory with --input <file> or pipe it on stdin before retrying.',
        {
          operator_hints: [
            'cat inventory.json | npm run ledger:sync -- --site-hash <hash> --pretty',
            'npm run ledger:sync -- --site-id <uuid> --input inventory.json --pretty'
          ]
        }
      ))}\n`);
      exit(1);
      return null;
    }

    const parsedInput = normalizeSyncInputPayload(JSON.parse(inputText));
    const resolvedSupabase = supabase || supabaseLoader();
    const siteResolution = await siteResolver(resolvedSupabase, {
      siteId: options.siteId,
      siteHash: options.siteHash,
      licenseKey: options.licenseKey,
      siteUrl: options.siteUrl,
      installUuid: options.installUuid,
      siteFingerprint: options.siteFingerprint
    });

    if (siteResolution?.error || !siteResolution?.site?.id) {
      const resolutionError = typeof siteResolution?.error === 'string'
        ? siteResolution.error
        : 'SITE_RESOLUTION_FAILED';
      stderr.write(`${JSON.stringify(buildCliErrorPayload(
        resolutionError,
        resolutionError === 'AMBIGUOUS_LICENSE_SITE'
          ? 'License key resolved to multiple sites. Add --site-hash or --site-id to target one site.'
          : 'Failed to resolve a canonical site for image state sync.',
        {
          candidate_count: Number(siteResolution?.candidate_count || 0) || undefined
        }
      ))}\n`);
      exit(1);
      return null;
    }

    const scope = parsedInput.scope || options.scope;
    const beforeCoverage = await coverageResolver(resolvedSupabase, siteResolution.site.id, {
      scope
    });

    const result = await syncRunner(resolvedSupabase, {
      siteId: siteResolution.site.id,
      siteHash: siteResolution.site.site_hash || null,
      images: parsedInput.images,
      scope,
      allowDowngrade: Boolean(options.allowDowngrade || parsedInput.allowDowngrade),
      requestId: null
    });

    const afterCoverage = result.coverage || await coverageResolver(resolvedSupabase, siteResolution.site.id, {
      scope
    });
    const payload = {
      success: true,
      site: {
        site_id: siteResolution.site.id,
        site_hash: siteResolution.site.site_hash || null,
        site_url: siteResolution.site.site_url || null,
        matched_by: siteResolution.matchedBy || null
      },
      input: {
        requested_rows: Array.isArray(parsedInput.images) ? parsedInput.images.length : 0,
        scope,
        allow_downgrade: Boolean(options.allowDowngrade || parsedInput.allowDowngrade)
      },
      before: beforeCoverage,
      sync: {
        inserted: Number(result.inserted || 0),
        updated: Number(result.updated || 0),
        unchanged: Number(result.unchanged || 0),
        missing_rows_created: Number(result.missing_rows_created || 0),
        duplicate_input_rows: Number(result.duplicate_input_rows || 0),
        orphaned_existing_rows: Number(result.orphaned_existing_rows || 0),
        errors: result.errors || []
      },
      after: afterCoverage
    };

    const fatalSyncFailure = (Number(result.inserted || 0) + Number(result.updated || 0) + Number(result.unchanged || 0) === 0)
      && Array.isArray(result.errors)
      && result.errors.length > 0;

    if (fatalSyncFailure) {
      payload.success = false;
      payload.error = 'IMAGE_ALT_STATE_SYNC_FAILED';
      stderr.write(`${JSON.stringify(payload, null, options.pretty ? 2 : 0)}\n`);
      exit(1);
      return null;
    }

    stdout.write(`${JSON.stringify(payload, null, options.pretty ? 2 : 0)}\n`);
    return payload;
  } catch (error) {
    stderr.write(`${JSON.stringify(buildCliErrorPayload(
      'IMAGE_ALT_STATE_SYNC_CLI_FAILED',
      error.message
    ))}\n`);
    exit(1);
    return null;
  }
}

if (require.main === module) {
  runImageAltStateSyncCli();
}

module.exports = {
  getUsageText,
  normalizeSyncInputPayload,
  parseSyncCliArgs,
  readSyncInput,
  runImageAltStateSyncCli
};
