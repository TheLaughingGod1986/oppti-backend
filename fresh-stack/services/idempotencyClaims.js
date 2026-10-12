const logger = require('../lib/logger');
const { serializeSupabaseError } = require('../lib/supabaseErrors');

const TABLE = 'generation_idempotency_claims';
const DEFAULT_CLAIM_TTL_MS = 2 * 60 * 1000;
const DEFAULT_REPLAY_TTL_MS = 24 * 60 * 60 * 1000;

function isUniqueViolation(error) {
  return Boolean(error) && (error.code === '23505' || /duplicate key/i.test(error.message || ''));
}

function isMissingTable(error) {
  return Boolean(error) && (error.code === '42P01' || error.code === 'PGRST205');
}

/**
 * Atomically claim (scope, key). Returns:
 *  { claimed: true }                         -> caller owns the key
 *  { claimed: false, existing }              -> someone else holds / finished it
 *  { claimed: true, degraded: true }         -> claims table unavailable; fail open
 */
async function claimIdempotencyKey(supabase, { scope, key, endpoint = 'api/alt-text', requestId = null, ttlMs = DEFAULT_CLAIM_TTL_MS, now = Date.now() }) {
  const row = {
    scope,
    idempotency_key: key,
    endpoint,
    status: 'in_progress',
    owner_request_id: requestId,
    expires_at: new Date(now + ttlMs).toISOString()
  };

  const { error } = await supabase.from(TABLE).insert(row);
  if (!error) return { claimed: true };

  if (!isUniqueViolation(error)) {
    logger.warn('[idempotency] claim_insert_failed_fail_open', {
      scope, error: serializeSupabaseError(error), missing_table: isMissingTable(error)
    });
    return { claimed: true, degraded: true };
  }

  const existing = await getClaim(supabase, { scope, key });
  if (!existing) {
    // Released between our insert and read: try once more.
    const retry = await supabase.from(TABLE).insert(row);
    if (!retry.error) return { claimed: true };
    return { claimed: false, existing: await getClaim(supabase, { scope, key }) };
  }

  // Take over a claim whose owner crashed (in_progress past expiry) or an
  // expired replay record. The conditional UPDATE is the atomic takeover.
  if (new Date(existing.expires_at).getTime() < now) {
    const { data: taken, error: takeErr } = await supabase
      .from(TABLE)
      .update({ ...row, response_status: null, response_body: null, updated_at: new Date(now).toISOString() })
      .eq('scope', scope)
      .eq('idempotency_key', key)
      .eq('expires_at', existing.expires_at)
      .select('idempotency_key');
    if (!takeErr && Array.isArray(taken) && taken.length === 1) return { claimed: true, takeover: true };
  }

  return { claimed: false, existing };
}

async function getClaim(supabase, { scope, key }) {
  const { data, error } = await supabase
    .from(TABLE)
    .select('scope, idempotency_key, status, response_status, response_body, expires_at')
    .eq('scope', scope)
    .eq('idempotency_key', key)
    .maybeSingle();
  if (error) {
    logger.warn('[idempotency] claim_read_failed', { scope, error: serializeSupabaseError(error) });
    return null;
  }
  return data || null;
}

async function completeIdempotencyClaim(supabase, { scope, key, status, body, replayTtlMs = DEFAULT_REPLAY_TTL_MS, now = Date.now() }) {
  const { error } = await supabase
    .from(TABLE)
    .update({
      status: 'succeeded',
      response_status: status,
      response_body: body,
      expires_at: new Date(now + replayTtlMs).toISOString(),
      updated_at: new Date(now).toISOString()
    })
    .eq('scope', scope)
    .eq('idempotency_key', key);
  if (error) logger.warn('[idempotency] claim_complete_failed', { scope, error: serializeSupabaseError(error) });
}

// Failed / denied runs release the key so a later retry behaves as before.
async function releaseIdempotencyClaim(supabase, { scope, key }) {
  const { error } = await supabase
    .from(TABLE)
    .delete()
    .eq('scope', scope)
    .eq('idempotency_key', key)
    .eq('status', 'in_progress');
  if (error) logger.warn('[idempotency] claim_release_failed', { scope, error: serializeSupabaseError(error) });
}

module.exports = {
  claimIdempotencyKey,
  getClaim,
  completeIdempotencyClaim,
  releaseIdempotencyClaim,
  isUniqueViolation
};
