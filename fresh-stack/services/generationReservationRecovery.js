const { finalizeSiteGeneration } = require('./siteQuota');
const logger = require('../lib/logger');

// These providers have request budgets <= 120 seconds. Reserve happens per
// item immediately before the provider call, including bulk workers. Thirty
// minutes is deliberately conservative; queued jobs have no reservation yet.
const STALE_AFTER_MS = 30 * 60 * 1000;
const RECOVERABLE_ENDPOINTS = [
  'api/alt-text', 'api/jobs', 'api/titles/generate', 'api/titles/jobs',
  'api/internal-linking/suggest'
];

/** Recover durable orphan rows after an outage/restart, never billing events. */
async function recoverStaleGenerationReservations(supabase, { now = Date.now() } = {}) {
  if (!supabase?.from || !supabase?.rpc) return { released: 0, failed: 0, skipped: true };
  const { data, error } = await supabase.from('generation_requests')
    .select('id')
    .eq('status', 'reserved')
    .lt('created_at', new Date(now - STALE_AFTER_MS).toISOString())
    .in('metadata->>endpoint', RECOVERABLE_ENDPOINTS)
    .order('created_at', { ascending: true })
    .limit(100);
  if (error) return { released: 0, failed: 0, error };
  let released = 0;
  let failed = 0;
  for (const row of data || []) {
    // The finalizer locks the row and is idempotent: if another worker has
    // settled it since the query, succeeded/released rows are never debited
    // or released twice. A provider result lost in a crash is not billable.
    const result = await finalizeSiteGeneration(supabase, {
      generationRequestId: row.id,
      success: false,
      finalMetadata: { recovery_reason: 'stale_provider_reservation' }
    });
    if (result.error || result.data?.ok === false) failed += 1;
    else if (result.data?.status === 'released') released += 1;
  }
  return { scanned: (data || []).length, released, failed };
}

function scheduleGenerationReservationRecovery(supabase) {
  let running = false;
  let stopped = false;
  const run = async () => {
    if (running || stopped) return;
    running = true;
    try {
      const result = await recoverStaleGenerationReservations(supabase);
      if (result.error || result.failed) {
        logger.warn('[QuotaRecovery] Recovery incomplete; durable rows retained for next pass', {
          failed: result.failed, error_code: result.error?.code || null
        });
      } else if (result.released) {
        logger.info('[QuotaRecovery] Released stale provider reservations', { count: result.released });
      }
    } catch (error) {
      logger.warn('[QuotaRecovery] Recovery unavailable; will retry', { error_code: error.code || null });
    } finally {
      running = false;
    }
  };
  const timer = setInterval(run, 60 * 1000);
  timer.unref?.();
  void run();
  return () => { stopped = true; clearInterval(timer); };
}
module.exports = { recoverStaleGenerationReservations, scheduleGenerationReservationRecovery, STALE_AFTER_MS, RECOVERABLE_ENDPOINTS };
