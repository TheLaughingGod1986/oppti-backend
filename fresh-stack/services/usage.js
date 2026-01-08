const { computePeriodStart } = require('./quota');
const logger = require('../lib/logger');

/**
 * Record usage with per-user and per-site tracking.
 */
async function recordUsage(supabase, {
  licenseKey,
  licenseId,
  siteHash,
  userId,
  userEmail,
  creditsUsed = 1,
  promptTokens,
  completionTokens,
  totalTokens,
  cached = false,
  modelUsed = 'gpt-4o-mini',
  generationTimeMs,
  imageUrl,
  imageFilename,
  pluginVersion,
  endpoint = 'api/alt-text',
  status = 'success',
  errorMessage = null
}) {
  const payload = {
    license_key: licenseKey,
    site_hash: siteHash,
    user_id: userId || null,
    user_email: userEmail || null,
    credits_used: creditsUsed,
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: totalTokens ?? (promptTokens && completionTokens ? promptTokens + completionTokens : null),
    cached,
    model_used: modelUsed,
    generation_time_ms: generationTimeMs,
    image_url: imageUrl,
    image_filename: imageFilename,
    plugin_version: pluginVersion,
    endpoint,
    status,
    error_message: errorMessage
  };

  logger.debug('[usage] Inserting usage log', { 
    license_key: licenseKey ? `${licenseKey.substring(0, 8)}...` : 'missing',
    site_hash: siteHash,
    credits_used: creditsUsed 
  });
  
  const { error } = await supabase.from('usage_logs').insert(payload);

  if (error) {
    logger.error('[usage] Failed to insert usage log', { error: error.message, code: error.code });
  } else {
    logger.info('[usage] Usage log inserted successfully');
  }

  // Update quota summary for this period
  if (!error && licenseKey) {
    logger.debug('[usage] Updating quota summary', { licenseKey: `${licenseKey.substring(0, 8)}...` });
    await updateQuotaSummary(supabase, licenseKey, creditsUsed, siteHash);
  }

  return { error };
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
  const { getLimits } = require('./license');
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
