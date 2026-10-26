/**
 * On sign-up, attach the registering site's earlier guest-trial rows to the
 * new account so its first use is not lost from per-account reporting.
 *
 * Scope is deliberately narrow:
 *  - only the site resolved from the register request, and only when that
 *    site belongs to the new account (never a shared or foreign site);
 *  - usage_logs: same site_hash, is_trial = true, license_id and user_id NULL;
 *  - generation_requests: same site_id, quota_source = 'trial', user_id NULL;
 *  - only rows created up to the moment of sign-up;
 *  - a NULL id is filled, a non-NULL id is never overwritten, so a repeat
 *    call is a no-op.
 * is_trial, quota_source and auth_state are left as they are: the rows stay
 * trial history and keep being excluded from paid/free credit totals.
 *
 * Off unless LINK_GUEST_TRIAL_ON_SIGNUP is set; when off it only logs how
 * many rows it would link. When on it logs and audits the exact row ids so
 * the change can be undone.
 */

const logger = require('../lib/logger');
const { recordSiteAudit } = require('./siteQuota');

const ROW_LIMIT = 500;
const AUDIT_EVENT = 'guest_trial_rows_linked';

function isGuestTrialLinkEnabled(env = process.env) {
  const raw = String(env.LINK_GUEST_TRIAL_ON_SIGNUP || '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

function siteBelongsToAccount(site, account) {
  if (!site?.id || !site?.site_hash || !account?.id || !account?.license_key) return false;
  if (site.license_key && site.license_key !== account.license_key) return false;
  if (site.owner_user_id && site.owner_user_id !== account.id) return false;
  if (site.license_id && site.license_id !== account.id) return false;
  return true;
}

function idsOf(rows) {
  return (Array.isArray(rows) ? rows : []).map((row) => row?.id).filter(Boolean);
}

async function findGuestUsageLogIds(supabase, site, cutoff) {
  const { data, error } = await supabase
    .from('usage_logs')
    .select('id')
    .eq('site_hash', site.site_hash)
    .eq('is_trial', true)
    .is('license_id', null)
    .is('user_id', null)
    .lte('created_at', cutoff)
    .limit(ROW_LIMIT);
  if (error) throw new Error(`usage_logs lookup failed: ${error.message}`);
  return idsOf(data);
}

async function findGuestGenerationRequestIds(supabase, site, cutoff) {
  const { data, error } = await supabase
    .from('generation_requests')
    .select('id')
    .eq('site_id', site.id)
    .eq('quota_source', 'trial')
    .is('user_id', null)
    .lte('created_at', cutoff)
    .limit(ROW_LIMIT);
  if (error) throw new Error(`generation_requests lookup failed: ${error.message}`);
  return idsOf(data);
}

async function fillNullColumn(supabase, table, column, value, ids) {
  if (!ids.length) return [];
  const { data, error } = await supabase
    .from(table)
    .update({ [column]: value })
    .in('id', ids)
    .is(column, null)
    .select('id');
  if (error) throw new Error(`${table} link failed: ${error.message}`);
  return idsOf(data);
}

async function linkGuestTrialRowsOnSignup({
  supabase,
  account,
  site,
  sharedSite = false,
  connectionSource = 'register',
  requestId = null,
  enabled = isGuestTrialLinkEnabled(),
  now = new Date()
} = {}) {
  const result = {
    mode: enabled ? 'applied' : 'dry_run',
    skipped: null,
    usage_logs: 0,
    generation_requests: 0,
    usage_log_ids: [],
    generation_request_ids: []
  };

  if (!supabase) return { ...result, skipped: 'no_database' };
  if (sharedSite || !siteBelongsToAccount(site, account)) {
    return { ...result, skipped: 'site_not_owned_by_account' };
  }

  const cutoff = (account.created_at && !Number.isNaN(Date.parse(account.created_at))
    ? new Date(account.created_at)
    : now).toISOString();

  try {
    const usageLogIds = await findGuestUsageLogIds(supabase, site, cutoff);
    const generationRequestIds = await findGuestGenerationRequestIds(supabase, site, cutoff);

    if (!enabled) {
      result.usage_logs = usageLogIds.length;
      result.generation_requests = generationRequestIds.length;
      logger.info('[Auth] guest_trial_link', {
        mode: 'dry_run',
        connection_source: connectionSource,
        request_id: requestId,
        account_id: account.id,
        site_id: site.id,
        would_link_usage_logs: result.usage_logs,
        would_link_generation_requests: result.generation_requests
      });
      return result;
    }

    result.usage_log_ids = await fillNullColumn(supabase, 'usage_logs', 'license_id', account.id, usageLogIds);
    result.generation_request_ids = await fillNullColumn(
      supabase, 'generation_requests', 'user_id', account.id, generationRequestIds
    );
    result.usage_logs = result.usage_log_ids.length;
    result.generation_requests = result.generation_request_ids.length;

    logger.info('[Auth] guest_trial_link', {
      mode: 'applied',
      connection_source: connectionSource,
      request_id: requestId,
      account_id: account.id,
      site_id: site.id,
      linked_usage_logs: result.usage_logs,
      linked_generation_requests: result.generation_requests,
      usage_log_ids: result.usage_log_ids,
      generation_request_ids: result.generation_request_ids
    });

    if (result.usage_logs || result.generation_requests) {
      await recordSiteAudit(supabase, {
        siteId: site.id,
        actorUserId: account.id,
        eventType: AUDIT_EVENT,
        severity: 'info',
        requestId,
        metadata: {
          connection_source: connectionSource,
          linked_at: now.toISOString(),
          usage_log_ids: result.usage_log_ids,
          generation_request_ids: result.generation_request_ids
        }
      });
    }
    return result;
  } catch (error) {
    logger.warn('[Auth] guest_trial_link_failed', {
      mode: result.mode,
      connection_source: connectionSource,
      request_id: requestId,
      account_id: account.id,
      site_id: site.id,
      linked_usage_log_ids: result.usage_log_ids,
      linked_generation_request_ids: result.generation_request_ids,
      error: error?.message || String(error)
    });
    return { ...result, skipped: 'error' };
  }
}

module.exports = {
  AUDIT_EVENT,
  isGuestTrialLinkEnabled,
  linkGuestTrialRowsOnSignup
};
