const { computePeriodStart } = require('./quota');
const { getLimits } = require('./planLimits');
const { trackGenerationMilestone, trackCreditsExhausted } = require('../../src/services/loops');
const logger = require('../lib/logger');
const { serializeSupabaseError } = require('../lib/supabaseErrors');
const { isInternalTelemetryHost } = require('../lib/siteIdentity');

/**
 * Check if a string is a valid UUID format
 */
function isValidUUID(str) {
  if (!str || typeof str !== 'string') return false;
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return uuidRegex.test(str);
}

/**
 * Record usage with per-user and per-site tracking.
 */
async function recordUsage(supabase, {
  licenseKey,
  licenseId,
  siteHash,
  installHash,
  siteUrl,
  domain,
  userId,
  userEmail,
  creditsUsed = 1,
  endpoint = 'api/alt-text',
  eventType,
  imageCount = 1,
  imageId,
  promptTokens,
  completionTokens,
  totalTokens,
  cached = false,
  modelUsed = 'gpt-4o-mini',
  generationTimeMs,
  imageUrl,
  imageFilename,
  pluginVersion,
  wpVersion,
  phpVersion,
  authState,
  planKey,
  requestSource,
  pluginChannel,
  environment,
  requestId,
  generationBatchId,
  userAgent,
  isTrial,
  status = 'success',
  errorMessage = null
}) {
  // Resolve the authoritative account attribution (licenses.id).
  // Prefer an explicitly-passed licenseId; otherwise look it up from
  // licenseKey so usage_logs.license_id is reliably populated.
  let validatedLicenseId = (licenseId && isValidUUID(licenseId)) ? licenseId : null;
  if (!validatedLicenseId && licenseKey) {
    try {
      const { data: licenseRow } = await supabase
        .from('licenses')
        .select('id')
        .eq('license_key', licenseKey)
        .maybeSingle();
      if (licenseRow?.id && isValidUUID(licenseRow.id)) {
        validatedLicenseId = licenseRow.id;
      }
    } catch (lookupErr) {
      logger.debug('[usage] license_id_lookup_failed', {
        license_key: licenseKey ? `${licenseKey.substring(0, 8)}...` : null,
        error: lookupErr?.message || String(lookupErr)
      });
    }
  }

  // usage_logs.user_id is deprecated for new writes: never persist a
  // licenses.id into it. Keep it only for a genuinely distinct non-license
  // user identity (none exist today, so this resolves to null in practice).
  const validatedUserId = (userId && isValidUUID(userId) && userId !== validatedLicenseId)
    ? userId
    : null;

  const isInternal = isInternalTelemetryHost({ domain, siteUrl });

  const payload = {
    license_key: licenseKey || null,
    license_id: validatedLicenseId,
    site_hash: siteHash || null,
    install_hash: installHash || null,
    site_url: siteUrl || null,
    domain: domain || null,
    user_id: validatedUserId,
    user_email: userEmail || null,
    credits_used: creditsUsed,
    endpoint: endpoint || 'api/alt-text',
    event_type: eventType || endpoint || 'generation',
    image_count: Math.max(1, Number(imageCount) || 1),
    image_id: imageId || null,
    prompt_tokens: promptTokens || null,
    completion_tokens: completionTokens || null,
    total_tokens: totalTokens ?? (promptTokens && completionTokens ? promptTokens + completionTokens : null),
    cached,
    model_used: modelUsed,
    generation_time_ms: generationTimeMs || null,
    image_url: imageUrl || null,
    image_filename: imageFilename || null,
    plugin_version: pluginVersion || null,
    wp_version: wpVersion || null,
    php_version: phpVersion || null,
    is_trial: typeof isTrial === 'boolean' ? isTrial : authState === 'guest_trial',
    auth_state: authState || (validatedUserId ? 'authenticated_unknown' : null),
    plan_key: planKey || null,
    request_source: requestSource || null,
    plugin_channel: pluginChannel || null,
    environment: environment || null,
    request_id: requestId || null,
    generation_batch_id: generationBatchId || null,
    user_agent: userAgent || null,
    is_internal: isInternal,
    status: status || 'success',
    error_message: errorMessage || null
  };

  logger.debug('[usage] Inserting usage log', { 
    license_key: licenseKey ? `${licenseKey.substring(0, 8)}...` : 'missing',
    license_id: validatedLicenseId ? `${validatedLicenseId.substring(0, 8)}...` : 'null (invalid or missing)',
    user_id: validatedUserId ? `${validatedUserId.substring(0, 8)}...` : `null (original: ${userId || 'missing'}, valid UUID: ${userId ? isValidUUID(userId) : false})`,
    site_hash: siteHash,
    credits_used: creditsUsed 
  });
  
  const insertUsageLog = (insertPayload) => supabase.from('usage_logs').insert(insertPayload).select();
  let { error, data } = await insertUsageLog(payload);
  let schemaFallbackUsed = false;

  if (error && isTelemetrySchemaError(error)) {
    schemaFallbackUsed = true;
    const legacyPayload = {
      license_key: payload.license_key,
      license_id: payload.license_id,
      site_hash: payload.site_hash,
      user_id: payload.user_id,
      user_email: payload.user_email,
      credits_used: payload.credits_used,
      prompt_tokens: payload.prompt_tokens,
      completion_tokens: payload.completion_tokens,
      total_tokens: payload.total_tokens,
      cached: payload.cached,
      model_used: payload.model_used,
      generation_time_ms: payload.generation_time_ms,
      image_url: payload.image_url,
      image_filename: payload.image_filename,
      plugin_version: payload.plugin_version,
      endpoint: payload.endpoint,
      status: payload.status,
      error_message: payload.error_message
    };
    const fallback = await insertUsageLog(legacyPayload);
    error = fallback.error;
    data = fallback.data;
  }

  if (error) {
    logger.error('[usage] usage_log_write', {
      table: 'usage_logs',
      success: false,
      site_hash: payload.site_hash || null,
      endpoint: payload.endpoint,
      status: payload.status,
      schema_fallback_used: schemaFallbackUsed,
      error: serializeSupabaseError(error)
    });
    logger.error('[usage] Failed to insert usage log', { 
      operation: 'usage_logs_insert',
      error: serializeSupabaseError(error),
      payload: {
        ...payload,
        license_key: payload.license_key ? `${payload.license_key.substring(0, 8)}...` : null,
        user_id: payload.user_id || null,
        license_id: payload.license_id || null
      }
    });
  } else {
    logger.info('[usage] usage_log_write', {
      table: 'usage_logs',
      success: true,
      inserted_id: data?.[0]?.id || null,
      site_hash: payload.site_hash || null,
      endpoint: payload.endpoint,
      status: payload.status
    });
    logger.info('[usage] Usage log inserted successfully', {
      operation: 'usage_logs_insert',
      inserted_id: data?.[0]?.id || null,
      site_hash: payload.site_hash,
      endpoint: payload.endpoint,
      status: payload.status,
      schema_fallback_used: schemaFallbackUsed,
      cached: payload.cached,
      credits_used: payload.credits_used
    });

    if (userEmail && licenseKey) {
      (async () => {
        try {
          const { data: license } = await supabase
            .from('licenses')
            .select('plan, billing_day_of_month')
            .eq('license_key', licenseKey)
            .single();

          if (license) {
            const periodStart = computePeriodStart(license.billing_day_of_month || 1, new Date());
            const { data: logs } = await supabase
              .from('usage_logs')
              .select('credits_used')
              .eq('license_key', licenseKey)
              .gte('created_at', periodStart.toISOString());

            const generationsCount = logs?.length || 0;
            const totalCreditsUsed = (logs || []).reduce((sum, l) => sum + (l.credits_used || 1), 0);
            const creditsRemaining = Math.max(getLimits(license.plan).credits - totalCreditsUsed, 0);

            await trackGenerationMilestone({ email: userEmail, generationsCount, imagesUnprocessed: 0 });
            if (creditsRemaining === 0) {
              await trackCreditsExhausted({ email: userEmail, imagesUnprocessed: 0 });
            }
          }
        } catch (loopsErr) {
          logger.debug('[Loops] generation tracking error', { error: loopsErr.message });
        }
      })();
    }
  }

  // Note: We do NOT manually call updateQuotaSummary() here because:
  // The database trigger `trg_update_quota_summary` automatically updates quota_summaries
  // when a row is inserted into usage_logs. Calling it manually would cause double-counting.
  // The trigger handles quota updates to ensure data consistency even if code paths skip manual updates.

  return {
    error,
    data: Array.isArray(data) ? data[0] || null : data || null,
    table: 'usage_logs',
    quota_summary_expected: Boolean(!error && payload.license_key)
  };
}

function isTelemetrySchemaError(error) {
  const message = String(error?.message || error?.details || '').toLowerCase();
  const code = String(error?.code || '').toLowerCase();
  return code === 'pgrst204'
    || code === '42703'
    || message.includes('could not find')
    || message.includes('column')
    || message.includes('schema cache');
}

/**
 * Update quota summary for current period (upsert).
 */
async function updateQuotaSummary(supabase, licenseKey, creditsUsed, siteHash) {
  // Get license to find billing day
  const { data: license } = await supabase
    .from('licenses')
    .select('billing_day_of_month, plan')
    .eq('license_key', licenseKey)
    .single();

  if (!license) return;

  const billingDay = license.billing_day_of_month || 1;
  const periodStart = computePeriodStart(billingDay, new Date());
  const periodEnd = new Date(periodStart);
  periodEnd.setMonth(periodEnd.getMonth() + 1);

  // Get current limits
  const { getLimits } = require('./planLimits');
  const limits = getLimits(license.plan);
  const totalLimit = limits.credits;

  // Check if summary exists
  const { data: existing } = await supabase
    .from('quota_summaries')
    .select('*')
    .eq('license_key', licenseKey)
    .eq('period_start', periodStart.toISOString())
    .maybeSingle();

  if (existing) {
    // Update existing summary
    const newTotalCredits = (existing.total_credits_used || 0) + creditsUsed;
    const siteUsage = existing.site_usage || {};
    siteUsage[siteHash] = (siteUsage[siteHash] || 0) + creditsUsed;

    const { error: updateError } = await supabase
      .from('quota_summaries')
      .update({
        total_credits_used: newTotalCredits,
        site_usage: siteUsage,
        updated_at: new Date().toISOString()
      })
      .eq('id', existing.id);
    
    if (updateError) {
      logger.error('[usage] Failed to update quota summary', { error: updateError.message });
      return;
    }
    
    logger.debug('[usage] Quota summary updated', {
      licenseKey: `${licenseKey.substring(0, 8)}...`,
      newTotalCredits,
      siteUsage
    });
  } else {
    // Create new summary
    const siteUsage = { [siteHash]: creditsUsed };
    const { error: insertError } = await supabase
      .from('quota_summaries')
      .insert({
        license_key: licenseKey,
        period_start: periodStart.toISOString(),
        period_end: periodEnd.toISOString(),
        total_credits_used: creditsUsed,
        total_limit: totalLimit,
        site_usage: siteUsage
      });
    
    if (insertError) {
      logger.error('[usage] Failed to insert quota summary', { error: insertError.message });
      return;
    }
    
    logger.debug('[usage] Quota summary created', {
      licenseKey: `${licenseKey.substring(0, 8)}...`,
      creditsUsed,
      siteUsage
    });
  }
}

/**
 * Get usage breakdown by user for a given period.
 */
async function getUserUsage(supabase, { licenseKey, siteHash, periodStart, periodEnd }) {
  const { data, error } = await supabase
    .from('usage_logs')
    .select('user_email, user_id, credits_used, created_at')
    .eq('site_hash', siteHash)
    .gte('created_at', periodStart.toISOString())
    .lt('created_at', periodEnd.toISOString());

  if (error) return { error };

  const map = {};
  for (const row of data || []) {
    const key = row.user_email || row.user_id || 'unknown';
    if (!map[key]) {
      map[key] = { user_email: row.user_email, user_id: row.user_id, credits_used: 0, last_activity: null };
    }
    map[key].credits_used += Number(row.credits_used || 0);
    const ts = new Date(row.created_at);
    if (!map[key].last_activity || ts > new Date(map[key].last_activity)) {
      map[key].last_activity = ts.toISOString();
    }
  }

  return { users: Object.values(map) };
}

/**
 * Get usage breakdown by site (agency).
 */
async function getSiteUsage(supabase, { licenseKey, periodStart, periodEnd }) {
  let licenseId = null;
  if (licenseKey) {
    const { data: lic } = await supabase
      .from('licenses')
      .select('id')
      .eq('license_key', licenseKey)
      .single();
    licenseId = lic?.id || null;
  }

  const query = supabase
    .from('usage_logs')
    .select('site_hash, credits_used, created_at')
    .gte('created_at', periodStart.toISOString())
    .lt('created_at', periodEnd.toISOString());

  if (licenseId) query.eq('license_id', licenseId);

  const { data, error } = await query;

  if (error) return { error };

  const map = {};
  for (const row of data || []) {
    const key = row.site_hash || 'unknown';
    if (!map[key]) {
      map[key] = { site_hash: key, credits_used: 0, last_activity: null };
    }
    map[key].credits_used += Number(row.credits_used || 0);
    const ts = new Date(row.created_at);
    if (!map[key].last_activity || ts > new Date(map[key].last_activity)) {
      map[key].last_activity = ts.toISOString();
    }
  }

  return { sites: Object.values(map) };
}

/**
 * Get usage logs with optional filters.
 */
async function getUsageLogs(supabase, { licenseKey, siteHash, limit = 100 }) {
  const query = supabase
    .from('usage_logs')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (siteHash) query.eq('site_hash', siteHash);
  if (licenseKey) {
    // If license_id not present in usage_logs, rely on sites join
    // For now we filter by site_hash if licenseKey provided via sites table
    const { data: siteRows } = await supabase
      .from('sites')
      .select('site_hash')
      .eq('license_key', licenseKey);
    const hashes = (siteRows || []).map((s) => s.site_hash);
    if (hashes.length > 0) query.in('site_hash', hashes);
  }

  const { data, error } = await query;
  return { data, error };
}

function getPeriodBounds(billingDay) {
  const start = computePeriodStart(billingDay, new Date());
  const end = new Date(start);
  end.setMonth(end.getMonth() + 1);
  return { periodStart: start, periodEnd: end };
}

module.exports = {
  recordUsage,
  getUserUsage,
  getSiteUsage,
  getUsageLogs,
  getPeriodBounds
};
