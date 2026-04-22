const crypto = require('crypto');
const logger = require('../lib/logger');
const { serializeSupabaseError } = require('../lib/supabaseErrors');
const { buildSiteIdentity } = require('../lib/siteIdentity');
const {
  fetchAccountByLicenseKey,
  resolveCanonicalSite
} = require('./siteQuota');

const IMAGE_ALT_STATES = Object.freeze({
  MISSING: 'MISSING',
  GENERATED: 'GENERATED',
  NEEDS_REVIEW: 'NEEDS_REVIEW',
  APPROVED: 'APPROVED'
});

const DASHBOARD_REVIEW_STATES = Object.freeze([
  IMAGE_ALT_STATES.GENERATED,
  IMAGE_ALT_STATES.NEEDS_REVIEW
]);

const IMAGE_ALT_STATE_PRIORITY = Object.freeze({
  [IMAGE_ALT_STATES.MISSING]: 0,
  [IMAGE_ALT_STATES.GENERATED]: 1,
  [IMAGE_ALT_STATES.NEEDS_REVIEW]: 2,
  [IMAGE_ALT_STATES.APPROVED]: 3
});

const LEDGER_SYNC_SCOPES = Object.freeze({
  FULL_SITE: 'full_site',
  PARTIAL: 'partial'
});

function normalizeString(value, maxLength = 255) {
  if (value === undefined || value === null) return null;
  const normalized = String(value).trim();
  if (!normalized) return null;
  return normalized.slice(0, maxLength);
}

function hashValue(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function normalizeState(value) {
  const normalized = normalizeString(value, 32);
  if (!normalized) return null;
  const upper = normalized.toUpperCase();
  return Object.values(IMAGE_ALT_STATES).includes(upper) ? upper : null;
}

function normalizeMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return { ...value };
}

function normalizeTimestamp(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function buildDashboardCountsFromLedgerCounts(counts = {}) {
  const missing = Number(counts.missing || 0);
  const toReview = Number(counts.generated || 0) + Number(counts.needs_review || 0);
  return {
    missing,
    to_review: toReview,
    optimized: Number(counts.approved || 0),
    total_attention: missing + toReview
  };
}

function buildLedgerCoverage({
  counts = {},
  scope = LEDGER_SYNC_SCOPES.PARTIAL,
  inputImageCount = null,
  orphanedExistingRows = 0
} = {}) {
  const totalRows = Number(counts.total_rows || 0);
  const normalizedInputCount = Number.isFinite(Number(inputImageCount))
    ? Math.max(0, Math.trunc(Number(inputImageCount)))
    : null;
  const normalizedOrphans = Math.max(0, Math.trunc(Number(orphanedExistingRows || 0)));

  let status = 'ZERO_ROWS';
  if (totalRows > 0) {
    status = 'PARTIAL_LEDGER';
    if (
      scope === LEDGER_SYNC_SCOPES.FULL_SITE
      && normalizedInputCount !== null
      && normalizedInputCount > 0
      && normalizedOrphans === 0
      && totalRows === normalizedInputCount
    ) {
      status = 'AUTHORITATIVE_LEDGER';
    }
  }

  return {
    status,
    snapshot_fallback_active: totalRows === 0,
    ledger_row_count: totalRows,
    input_image_count: normalizedInputCount,
    orphaned_existing_rows: normalizedOrphans,
    state_counts: {
      missing: Number(counts.missing || 0),
      generated: Number(counts.generated || 0),
      needs_review: Number(counts.needs_review || 0),
      approved: Number(counts.approved || 0)
    },
    dashboard_counts: buildDashboardCountsFromLedgerCounts(counts)
  };
}

function statePriority(state) {
  return IMAGE_ALT_STATE_PRIORITY[state] ?? -1;
}

function shouldApplyIncomingState(existingState, incomingState, forceState = false) {
  if (forceState || !existingState) return true;
  return statePriority(incomingState) >= statePriority(existingState);
}

function pickComparableLedgerFields(row = {}) {
  return {
    site_id: normalizeString(row.site_id),
    image_ref: normalizeString(row.image_ref),
    attachment_id: normalizeString(row.attachment_id),
    image_url: normalizeString(row.image_url, 2000),
    current_state: normalizeState(row.current_state),
    alt_text: row.alt_text === undefined ? null : row.alt_text,
    last_generated_at: normalizeTimestamp(row.last_generated_at),
    last_reviewed_at: normalizeTimestamp(row.last_reviewed_at),
    metadata: normalizeMetadata(row.metadata)
  };
}

function ledgerRowsEqual(left = {}, right = {}) {
  const normalizedLeft = pickComparableLedgerFields(left);
  const normalizedRight = pickComparableLedgerFields(right);
  return JSON.stringify(normalizedLeft) === JSON.stringify(normalizedRight);
}

function mergeSyncPayload(existingRow, incomingPayload, { forceState = false } = {}) {
  const existing = existingRow ? pickComparableLedgerFields(existingRow) : null;
  const incoming = pickComparableLedgerFields(incomingPayload);
  const incomingWins = shouldApplyIncomingState(existing?.current_state || null, incoming.current_state, forceState);
  const resolvedState = incomingWins
    ? incoming.current_state
    : (existing?.current_state || incoming.current_state);

  let resolvedAltText = existing?.alt_text ?? null;
  if (incomingWins) {
    if (resolvedState === IMAGE_ALT_STATES.MISSING && forceState) {
      resolvedAltText = null;
    } else if (incoming.alt_text !== null) {
      resolvedAltText = incoming.alt_text;
    } else if (!existing) {
      resolvedAltText = null;
    }
  }

  return {
    site_id: incoming.site_id,
    image_ref: incoming.image_ref,
    attachment_id: incoming.attachment_id || existing?.attachment_id || null,
    image_url: incoming.image_url || existing?.image_url || null,
    current_state: resolvedState,
    alt_text: resolvedAltText,
    last_generated_at: incomingWins
      ? (incoming.last_generated_at || existing?.last_generated_at || null)
      : (existing?.last_generated_at || incoming.last_generated_at || null),
    last_reviewed_at: incomingWins
      ? (incoming.last_reviewed_at || existing?.last_reviewed_at || null)
      : (existing?.last_reviewed_at || incoming.last_reviewed_at || null),
    metadata: {
      ...(existing?.metadata || {}),
      ...(incoming.metadata || {})
    }
  };
}

function buildSyncImagePayload(siteId, item = {}) {
  const state = normalizeState(item.current_state || item.currentState) || IMAGE_ALT_STATES.MISSING;
  const image = item.image && typeof item.image === 'object'
    ? item.image
    : {
        attachment_id: item.attachment_id || item.attachmentId || item.media_id || item.mediaId || item.image_id || item.imageId || null,
        url: item.image_url || item.imageUrl || null,
        filename: item.filename || item.fileName || null
      };
  const context = item.context && typeof item.context === 'object' ? item.context : {};
  const altText = state === IMAGE_ALT_STATES.MISSING
    ? null
    : (item.alt_text ?? item.altText);

  return buildLedgerPayload({
    siteId,
    state,
    image,
    context,
    body: item,
    altText,
    generatedAt: normalizeTimestamp(item.last_generated_at || item.lastGeneratedAt),
    reviewedAt: normalizeTimestamp(item.last_reviewed_at || item.lastReviewedAt),
    metadata: normalizeMetadata(item.metadata)
  });
}

function extractAttachmentId({ image = {}, context = {}, body = {} } = {}) {
  return normalizeString(
    image.attachment_id
      || image.attachmentId
      || image.media_id
      || image.mediaId
      || image.image_id
      || image.imageId
      || context.attachment_id
      || context.attachmentId
      || context.media_id
      || context.mediaId
      || context.image_id
      || context.imageId
      || body.attachment_id
      || body.attachmentId
      || body.media_id
      || body.mediaId
      || body.image_id
      || body.imageId
      || null
  );
}

function resolveImageAltIdentity({
  image = {},
  context = {},
  body = {}
} = {}) {
  const attachmentId = extractAttachmentId({ image, context, body });
  const imageUrl = normalizeString(
    image.url
      || image.image_url
      || context.image_url
      || context.imageUrl
      || body.image_url
      || body.imageUrl
      || null,
    2000
  );
  const filename = normalizeString(
    image.filename
      || image.fileName
      || context.filename
      || context.fileName
      || body.filename
      || body.fileName
      || null,
    500
  );
  const explicitImageId = normalizeString(
    image.id
      || context.id
      || context.image_ref
      || context.imageRef
      || body.id
      || body.image_ref
      || body.imageRef
      || null
  );

  if (attachmentId) {
    return {
      attachment_id: attachmentId,
      image_ref: `attachment:${attachmentId}`,
      image_url: imageUrl,
      identity_source: 'attachment_id',
      error: null
    };
  }

  if (explicitImageId) {
    return {
      attachment_id: null,
      image_ref: `image:${explicitImageId}`,
      image_url: imageUrl,
      identity_source: 'image_id',
      error: null
    };
  }

  if (imageUrl) {
    return {
      attachment_id: null,
      image_ref: `url:${hashValue(imageUrl)}`,
      image_url: imageUrl,
      identity_source: 'image_url',
      error: null
    };
  }

  if (filename) {
    return {
      attachment_id: null,
      image_ref: `filename:${hashValue(filename)}`,
      image_url: null,
      identity_source: 'filename',
      error: null
    };
  }

  if (image.base64 || image.image_base64) {
    return {
      attachment_id: null,
      image_ref: `content:${hashValue(image.base64 || image.image_base64)}`,
      image_url: null,
      identity_source: 'image_content',
      error: null
    };
  }

  return {
    attachment_id: null,
    image_ref: null,
    image_url: null,
    identity_source: 'missing',
    error: 'INVALID_IMAGE_IDENTITY'
  };
}

function buildSiteIdentityFromRequest(req) {
  const account = req?.user || req?.license || null;
  return buildSiteIdentity({
    siteHash: req?.trialMode
      ? req?.trialSiteHash
      : (req?.header?.('X-Site-Key') || req?.header?.('X-Site-Hash') || req?.body?.site_id || req?.body?.siteId || null),
    installUuid: req?.trialMode
      ? req?.trialSiteHash
      : (
        req?.header?.('X-Install-UUID')
        || req?.header?.('X-WP-Install-UUID')
        || req?.header?.('X-Site-Key')
        || req?.header?.('X-Site-Hash')
        || req?.body?.install_uuid
        || req?.body?.installUuid
        || req?.body?.site_id
        || req?.body?.siteId
        || null
      ),
    siteUrl: req?.header?.('X-Site-URL') || req?.body?.site_url || req?.body?.siteUrl || null,
    siteFingerprint: req?.header?.('X-Site-Fingerprint') || req?.body?.site_fingerprint || req?.body?.siteFingerprint || null,
    allowDevelopment: Boolean(req?.trialMode || account || req?.header?.('X-License-Key'))
  });
}

async function resolveImageAltStateSiteContext(supabase, req, { createIfMissing = false } = {}) {
  const account = req?.user || req?.license || null;
  const licenseKey = req?.header?.('X-License-Key') || account?.license_key || null;
  const siteIdentity = buildSiteIdentityFromRequest(req);

  if (!siteIdentity?.isValid || siteIdentity?.error === 'INVALID_SITE_IDENTITY') {
    return {
      site: null,
      siteIdentity,
      error: 'INVALID_SITE_IDENTITY'
    };
  }

  const resolved = await resolveCanonicalSite(supabase, siteIdentity, {
    createIfMissing,
    legacyLicenseKey: licenseKey,
    account,
    requestId: req?.id || null
  });

  return {
    ...resolved,
    siteIdentity
  };
}

async function listSitesForLicense(supabase, {
  licenseKey,
  accountId = null
} = {}) {
  if (!supabase || !licenseKey) {
    return { data: [], error: null };
  }

  if (accountId) {
    const { data: memberships, error: membershipError } = await supabase
      .from('site_memberships')
      .select('site_id')
      .eq('user_id', accountId);

    if (!membershipError && Array.isArray(memberships) && memberships.length > 0) {
      const siteIds = memberships.map((membership) => membership.site_id).filter(Boolean);
      const { data, error } = await supabase
        .from('sites')
        .select('*')
        .in('id', siteIds);
      return { data: Array.isArray(data) ? data : [], error };
    }
  }

  const { data, error } = await supabase
    .from('sites')
    .select('*')
    .eq('license_key', licenseKey);

  return { data: Array.isArray(data) ? data : [], error };
}

async function resolveImageAltStateSyncTarget(supabase, {
  siteId = null,
  siteHash = null,
  siteUrl = null,
  siteFingerprint = null,
  installUuid = null,
  licenseKey = null
} = {}) {
  if (!supabase) {
    return {
      site: null,
      siteIdentity: null,
      error: 'SUPABASE_REQUIRED'
    };
  }

  if (siteId) {
    const { data, error } = await supabase
      .from('sites')
      .select('*')
      .eq('id', siteId)
      .maybeSingle();

    if (error) {
      return {
        site: null,
        siteIdentity: null,
        error
      };
    }

    if (data) {
      return {
        site: data,
        siteIdentity: null,
        matchedBy: 'id',
        created: false,
        error: null
      };
    }
  }

  const account = licenseKey ? await fetchAccountByLicenseKey(supabase, licenseKey) : null;
  const siteIdentity = buildSiteIdentity({
    siteHash,
    siteUrl,
    siteFingerprint,
    installUuid,
    allowDevelopment: true
  });

  const hasIdentitySelectors = Boolean(siteHash || siteUrl || siteFingerprint || installUuid);
  if (hasIdentitySelectors && (!siteIdentity?.isValid || siteIdentity?.error === 'INVALID_SITE_IDENTITY')) {
    return {
      site: null,
      siteIdentity,
      error: 'INVALID_SITE_IDENTITY'
    };
  }

  if (siteIdentity?.isValid && siteIdentity?.error !== 'INVALID_SITE_IDENTITY') {
    const resolved = await resolveCanonicalSite(supabase, siteIdentity, {
      createIfMissing: false,
      legacyLicenseKey: licenseKey,
      account,
      requestId: null
    });

    if (resolved?.site) {
      return {
        ...resolved,
        siteIdentity,
        error: null
      };
    }

    if (resolved?.error && resolved.error !== 'SITE_NOT_FOUND') {
      return {
        site: null,
        siteIdentity,
        error: resolved.error
      };
    }
  }

  if (!licenseKey) {
    return {
      site: null,
      siteIdentity: siteIdentity?.isValid ? siteIdentity : null,
      error: 'SITE_NOT_FOUND'
    };
  }

  const { data: sites, error } = await listSitesForLicense(supabase, {
    licenseKey,
    accountId: account?.id || null
  });

  if (error) {
    return {
      site: null,
      siteIdentity: siteIdentity?.isValid ? siteIdentity : null,
      error
    };
  }

  if (sites.length === 1) {
    return {
      site: sites[0],
      siteIdentity: siteIdentity?.isValid ? siteIdentity : null,
      matchedBy: 'license_key',
      created: false,
      error: null
    };
  }

  if (sites.length > 1) {
    return {
      site: null,
      siteIdentity: siteIdentity?.isValid ? siteIdentity : null,
      error: 'AMBIGUOUS_LICENSE_SITE',
      candidate_count: sites.length
    };
  }

  return {
    site: null,
    siteIdentity: siteIdentity?.isValid ? siteIdentity : null,
    error: 'SITE_NOT_FOUND'
  };
}

function buildLedgerPayload({
  siteId,
  state,
  image = {},
  context = {},
  body = {},
  altText,
  generatedAt,
  reviewedAt,
  metadata = {}
} = {}) {
  const identity = resolveImageAltIdentity({ image, context, body });
  const normalizedState = normalizeState(state);

  if (!siteId) {
    return { payload: null, identity, error: 'SITE_ID_REQUIRED' };
  }

  if (!normalizedState) {
    return { payload: null, identity, error: 'INVALID_IMAGE_STATE' };
  }

  if (identity.error) {
    return { payload: null, identity, error: identity.error };
  }

  const payload = {
    site_id: siteId,
    image_ref: identity.image_ref,
    current_state: normalizedState,
    updated_at: new Date().toISOString(),
    metadata: {
      ...(metadata || {}),
      identity_source: identity.identity_source
    }
  };

  if (identity.attachment_id) {
    payload.attachment_id = identity.attachment_id;
  }
  if (identity.image_url) {
    payload.image_url = identity.image_url;
  }
  if (altText !== undefined) {
    payload.alt_text = altText;
  }
  if (generatedAt) {
    payload.last_generated_at = generatedAt;
  }
  if (reviewedAt) {
    payload.last_reviewed_at = reviewedAt;
  }

  return { payload, identity, error: null };
}

async function upsertImageAltState(supabase, {
  siteId,
  state,
  image = {},
  context = {},
  body = {},
  altText,
  generatedAt = null,
  reviewedAt = null,
  metadata = {},
  requestId = null
} = {}) {
  const { payload, identity, error } = buildLedgerPayload({
    siteId,
    state,
    image,
    context,
    body,
    altText,
    generatedAt,
    reviewedAt,
    metadata
  });

  if (error) {
    logger.warn('[image-state] ledger_write_skipped', {
      site_id: siteId || null,
      state: state || null,
      request_id: requestId || null,
      error,
      identity_source: identity?.identity_source || null
    });
    return { data: null, error };
  }

  const { data, error: upsertError } = await supabase
    .from('image_alt_states')
    .upsert(payload, { onConflict: 'site_id,image_ref' })
    .select('id, site_id, attachment_id, image_ref, current_state, alt_text, image_url, last_generated_at, last_reviewed_at')
    .maybeSingle();

  if (upsertError) {
    logger.error('[image-state] ledger_write_failed', {
      table: 'image_alt_states',
      site_id: siteId,
      image_ref: payload.image_ref,
      state: payload.current_state,
      request_id: requestId || null,
      error: serializeSupabaseError(upsertError)
    });
    return { data: null, error: upsertError };
  }

  logger.info('[image-state] ledger_write_succeeded', {
    table: 'image_alt_states',
    site_id: siteId,
    image_ref: payload.image_ref,
    attachment_id: payload.attachment_id || null,
    state: payload.current_state,
    request_id: requestId || null
  });

  return { data: data || payload, error: null };
}

async function upsertGeneratedImageAltState(supabase, {
  siteId,
  image = {},
  context = {},
  altText,
  requestId = null,
  generationRequestId = null,
  state = IMAGE_ALT_STATES.NEEDS_REVIEW
} = {}) {
  return upsertImageAltState(supabase, {
    siteId,
    state,
    image,
    context,
    altText,
    generatedAt: new Date().toISOString(),
    metadata: {
      generation_request_id: generationRequestId || null,
      event: 'generation_completed'
    },
    requestId
  });
}

async function markImageAltStateApproved(supabase, {
  siteId,
  image = {},
  context = {},
  body = {},
  altText,
  requestId = null
} = {}) {
  return upsertImageAltState(supabase, {
    siteId,
    state: IMAGE_ALT_STATES.APPROVED,
    image,
    context,
    body,
    altText,
    reviewedAt: new Date().toISOString(),
    metadata: {
      event: 'approve'
    },
    requestId
  });
}

async function listImageAltStatesForSite(supabase, siteId) {
  if (!supabase || !siteId) {
    return { data: [], error: null };
  }

  const { data, error } = await supabase
    .from('image_alt_states')
    .select('id, site_id, image_ref, attachment_id, image_url, current_state, alt_text, last_generated_at, last_reviewed_at, metadata')
    .eq('site_id', siteId);

  return {
    data: Array.isArray(data) ? data : [],
    error
  };
}

async function syncImageAltStates(supabase, {
  siteId,
  siteHash = null,
  images = [],
  requestId = null,
  scope = LEDGER_SYNC_SCOPES.FULL_SITE,
  allowDowngrade = false
} = {}) {
  if (!supabase || !siteId) {
    return { count: 0, errors: [{ error: 'SITE_ID_REQUIRED' }] };
  }

  const { data: existingRows, error: existingError } = await listImageAltStatesForSite(supabase, siteId);
  if (existingError) {
    logger.error('[image-state] sync_failed', {
      table: 'image_alt_states',
      site_id: siteId,
      site_hash: siteHash || null,
      request_id: requestId || null,
      error: serializeSupabaseError(existingError)
    });
    return {
      count: 0,
      requested: Array.isArray(images) ? images.length : 0,
      inserted: 0,
      updated: 0,
      unchanged: 0,
      missing_rows_created: 0,
      duplicate_input_rows: 0,
      orphaned_existing_rows: 0,
      errors: [{ error: existingError }]
    };
  }

  const existingByRef = new Map(existingRows.map((row) => [row.image_ref, row]));
  const normalizedRows = new Map();
  const errors = [];
  let duplicateInputRows = 0;

  images.forEach((item, index) => {
    const { payload, error } = buildSyncImagePayload(siteId, item);

    if (error || !payload) {
      errors.push({ index, error: error || 'INVALID_IMAGE_STATE' });
      return;
    }

    const forceState = Boolean(
      item.force_state
      || item.forceState
      || item.allow_downgrade
      || item.allowDowngrade
      || allowDowngrade
    );

    const existingCandidate = normalizedRows.get(payload.image_ref);
    if (existingCandidate) {
      duplicateInputRows += 1;
      const mergedCandidate = mergeSyncPayload(existingCandidate.payload, payload, { forceState });
      normalizedRows.set(payload.image_ref, {
        payload: mergedCandidate,
        forceState: existingCandidate.forceState || forceState
      });
      return;
    }

    normalizedRows.set(payload.image_ref, {
      payload,
      forceState
    });
  });

  if (!normalizedRows.size) {
    const finalCounts = await countImageAltStatesForSite(supabase, siteId);
    const coverage = buildLedgerCoverage({
      counts: finalCounts,
      scope,
      inputImageCount: 0,
      orphanedExistingRows: scope === LEDGER_SYNC_SCOPES.FULL_SITE ? existingRows.length : 0
    });

    return {
      count: 0,
      requested: Array.isArray(images) ? images.length : 0,
      inserted: 0,
      updated: 0,
      unchanged: 0,
      missing_rows_created: 0,
      duplicate_input_rows: duplicateInputRows,
      orphaned_existing_rows: coverage.orphaned_existing_rows,
      errors,
      final_counts: finalCounts,
      dashboard_counts: coverage.dashboard_counts,
      coverage
    };
  }

  const rowsToWrite = [];
  let inserted = 0;
  let updated = 0;
  let unchanged = 0;
  let missingRowsCreated = 0;

  for (const [imageRef, candidate] of normalizedRows.entries()) {
    const existing = existingByRef.get(imageRef) || null;
    const nextRow = mergeSyncPayload(existing, candidate.payload, {
      forceState: Boolean(candidate.forceState)
    });

    if (!existing) {
      rowsToWrite.push({
        ...nextRow,
        updated_at: new Date().toISOString()
      });
      inserted += 1;
      if (nextRow.current_state === IMAGE_ALT_STATES.MISSING) {
        missingRowsCreated += 1;
      }
      continue;
    }

    if (ledgerRowsEqual(existing, nextRow)) {
      unchanged += 1;
      continue;
    }

    rowsToWrite.push({
      ...nextRow,
      updated_at: new Date().toISOString()
    });
    updated += 1;
  }

  if (rowsToWrite.length > 0) {
    const { error } = await supabase
      .from('image_alt_states')
      .upsert(rowsToWrite, { onConflict: 'site_id,image_ref' });

    if (error) {
      logger.error('[image-state] ledger_batch_write_failed', {
        table: 'image_alt_states',
        site_id: siteId,
        site_hash: siteHash || null,
        row_count: rowsToWrite.length,
        request_id: requestId || null,
        error: serializeSupabaseError(error)
      });
      return {
        count: 0,
        requested: Array.isArray(images) ? images.length : 0,
        inserted: 0,
        updated: 0,
        unchanged,
        missing_rows_created: 0,
        duplicate_input_rows: duplicateInputRows,
        orphaned_existing_rows: 0,
        errors: [...errors, { error }]
      };
    }

    logger.info('[image-state] ledger_batch_write_succeeded', {
      table: 'image_alt_states',
      site_id: siteId,
      site_hash: siteHash || null,
      row_count: rowsToWrite.length,
      request_id: requestId || null
    });
  }

  const inputImageCount = normalizedRows.size;
  const orphanedExistingRows = scope === LEDGER_SYNC_SCOPES.FULL_SITE
    ? existingRows.filter((row) => !normalizedRows.has(row.image_ref)).length
    : 0;
  const finalCounts = await countImageAltStatesForSite(supabase, siteId);
  const coverage = buildLedgerCoverage({
    counts: finalCounts,
    scope,
    inputImageCount,
    orphanedExistingRows
  });

  logger.info('[image-state] sync_completed', {
    site_id: siteId,
    site_hash: siteHash || null,
    scope,
    request_id: requestId || null,
    requested_rows: Array.isArray(images) ? images.length : 0,
    unique_images: inputImageCount,
    inserted,
    updated,
    unchanged,
    duplicate_input_rows: duplicateInputRows,
    missing_rows_created: missingRowsCreated,
    orphaned_existing_rows: orphanedExistingRows,
    final_state_counts: coverage.state_counts,
    coverage_status: coverage.status,
    snapshot_fallback_active: coverage.snapshot_fallback_active
  });

  return {
    count: inserted + updated,
    requested: Array.isArray(images) ? images.length : 0,
    inserted,
    updated,
    unchanged,
    missing_rows_created: missingRowsCreated,
    duplicate_input_rows: duplicateInputRows,
    orphaned_existing_rows: orphanedExistingRows,
    errors,
    final_counts: finalCounts,
    dashboard_counts: coverage.dashboard_counts,
    coverage
  };
}

async function countImageAltStatesForSite(supabase, siteId) {
  if (!supabase || !siteId) {
    return {
      available: false,
      source: 'image_alt_states_unavailable',
      total_rows: 0,
      missing: 0,
      generated: 0,
      needs_review: 0,
      approved: 0
    };
  }

  async function countWhere(stateFilter) {
    let query = supabase
      .from('image_alt_states')
      .select('id', { count: 'exact', head: true })
      .eq('site_id', siteId);

    if (Array.isArray(stateFilter)) {
      query = query.in('current_state', stateFilter);
    } else if (stateFilter) {
      query = query.eq('current_state', stateFilter);
    }

    const result = await query;
    return result;
  }

  const total = await countWhere(null);
  if (total.error) {
    logger.warn('[image-state] ledger_count_failed', {
      table: 'image_alt_states',
      site_id: siteId,
      error: serializeSupabaseError(total.error)
    });
    return {
      available: false,
      source: 'image_alt_states_error',
      total_rows: 0,
      missing: 0,
      generated: 0,
      needs_review: 0,
      approved: 0,
      error: total.error
    };
  }

  const [missing, generated, needsReview, approved] = await Promise.all([
    countWhere(IMAGE_ALT_STATES.MISSING),
    countWhere(IMAGE_ALT_STATES.GENERATED),
    countWhere(IMAGE_ALT_STATES.NEEDS_REVIEW),
    countWhere(IMAGE_ALT_STATES.APPROVED)
  ]);

  const firstError = [missing, generated, needsReview, approved].find((entry) => entry?.error)?.error || null;
  if (firstError) {
    logger.warn('[image-state] ledger_count_failed', {
      table: 'image_alt_states',
      site_id: siteId,
      error: serializeSupabaseError(firstError)
    });
    return {
      available: false,
      source: 'image_alt_states_error',
      total_rows: Number(total.count || 0),
      missing: 0,
      generated: 0,
      needs_review: 0,
      approved: 0,
      error: firstError
    };
  }

  return {
    available: true,
    source: 'image_alt_states',
    total_rows: Number(total.count || 0),
    missing: Number(missing.count || 0),
    generated: Number(generated.count || 0),
    needs_review: Number(needsReview.count || 0),
    approved: Number(approved.count || 0)
  };
}

async function getImageAltStateLedgerCoverage(supabase, siteId, options = {}) {
  const counts = await countImageAltStatesForSite(supabase, siteId);
  return {
    site_id: siteId || null,
    counts,
    ...buildLedgerCoverage({
      counts,
      scope: options.scope || LEDGER_SYNC_SCOPES.PARTIAL,
      inputImageCount: options.inputImageCount ?? null,
      orphanedExistingRows: options.orphanedExistingRows ?? 0
    })
  };
}

module.exports = {
  DASHBOARD_REVIEW_STATES,
  IMAGE_ALT_STATES,
  LEDGER_SYNC_SCOPES,
  buildDashboardCountsFromLedgerCounts,
  buildLedgerCoverage,
  buildSiteIdentityFromRequest,
  countImageAltStatesForSite,
  getImageAltStateLedgerCoverage,
  markImageAltStateApproved,
  normalizeState,
  resolveImageAltIdentity,
  resolveImageAltStateSiteContext,
  resolveImageAltStateSyncTarget,
  syncImageAltStates,
  upsertGeneratedImageAltState,
  upsertImageAltState
};
