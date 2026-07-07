/**
 * Customer health telemetry — scheduled inactivity and usage signals.
 *
 * Enable with CUSTOMER_HEALTH_CRON_ENABLED=1 on the API process.
 * For production, prefer an external cron hitting a dedicated endpoint.
 */

const logger = require('../lib/logger');
const { captureServerEvent } = require('../lib/posthog');

const INACTIVITY_THRESHOLDS = [
  { days: 14, event: 'customer_inactive_14_days' },
  { days: 30, event: 'customer_inactive_30_days' }
];

const POWER_USER_GENERATIONS_30D = 200;
const HIGH_USAGE_GENERATIONS_30D = 75;
const LOW_USAGE_GENERATIONS_30D = 5;

function daysBetween(fromIso, toDate = new Date()) {
  if (!fromIso) return null;
  const from = new Date(fromIso);
  if (Number.isNaN(from.getTime())) return null;
  return Math.floor((toDate.getTime() - from.getTime()) / (24 * 60 * 60 * 1000));
}

async function fetchSiteActivity(supabase) {
  if (!supabase) return [];

  const { data: sites, error } = await supabase
    .from('sites')
    .select('id, site_hash, site_url, license_key, status, updated_at, created_at')
    .eq('status', 'active')
    .limit(5000);

  if (error) {
    logger.warn('[customerHealth] site fetch failed', { error: error.message });
    return [];
  }

  return Array.isArray(sites) ? sites : [];
}

async function fetchGenerationCounts(supabase, siteIds) {
  if (!supabase || !siteIds.length) return new Map();

  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const counts = new Map();

  try {
    const { data, error } = await supabase
      .from('usage_events')
      .select('site_id')
      .in('site_id', siteIds)
      .gte('created_at', since);

    if (error || !Array.isArray(data)) {
      return counts;
    }

    for (const row of data) {
      if (!row?.site_id) continue;
      counts.set(row.site_id, (counts.get(row.site_id) || 0) + 1);
    }
  } catch (error) {
    logger.warn('[customerHealth] usage_events unavailable; usage tiers skipped', {
      error: error.message
    });
  }

  return counts;
}

async function emitCustomerHealthEvents(supabase) {
  const sites = await fetchSiteActivity(supabase);
  if (!sites.length) {
    return { processed: 0, emitted: 0 };
  }

  const siteIds = sites.map((site) => site.id).filter(Boolean);
  const generationCounts = await fetchGenerationCounts(supabase, siteIds);
  let emitted = 0;

  for (const site of sites) {
    const distinctId = site.site_hash || site.id;
    if (!distinctId) continue;

    const inactiveDays = daysBetween(site.updated_at || site.created_at);
    if (inactiveDays === null) continue;

    const baseProps = {
      site_id: site.id,
      site_install_id: site.site_hash || site.id,
      host: (() => {
        try {
          return site.site_url ? new URL(site.site_url).hostname.toLowerCase() : null;
        } catch (_error) {
          return null;
        }
      })(),
      inactive_days: inactiveDays,
      event_source: 'backend_cron',
      telemetry_version: '1'
    };

    for (const threshold of INACTIVITY_THRESHOLDS) {
      if (inactiveDays >= threshold.days) {
        const result = await captureServerEvent({
          event: threshold.event,
          distinctId,
          properties: {
            ...baseProps,
            $insert_id: `${threshold.event}:${site.id}:${new Date().toISOString().slice(0, 10)}`
          }
        });
        if (result.ok) emitted += 1;
      }
    }

    const generations30d = generationCounts.get(site.id) || 0;
    let usageEvent = null;
    if (generations30d >= POWER_USER_GENERATIONS_30D) {
      usageEvent = 'power_user';
    } else if (generations30d >= HIGH_USAGE_GENERATIONS_30D) {
      usageEvent = 'high_usage_customer';
    } else if (generations30d <= LOW_USAGE_GENERATIONS_30D) {
      usageEvent = 'low_usage_customer';
    }

    if (usageEvent) {
      const result = await captureServerEvent({
        event: usageEvent,
        distinctId,
        properties: {
          ...baseProps,
          generations_30d: generations30d,
          $insert_id: `${usageEvent}:${site.id}:${new Date().toISOString().slice(0, 10)}`
        }
      });
      if (result.ok) emitted += 1;
    }
  }

  logger.info('[customerHealth] cron completed', {
    processed: sites.length,
    emitted
  });

  return { processed: sites.length, emitted };
}

function scheduleCustomerHealthCron(supabase, {
  enabled = process.env.CUSTOMER_HEALTH_CRON_ENABLED === '1',
  intervalMs = Number(process.env.CUSTOMER_HEALTH_CRON_INTERVAL_MS || 24 * 60 * 60 * 1000)
} = {}) {
  if (!enabled) {
    logger.info('[customerHealth] cron disabled (set CUSTOMER_HEALTH_CRON_ENABLED=1 to enable)');
    return null;
  }

  const run = async () => {
    try {
      await emitCustomerHealthEvents(supabase);
    } catch (error) {
      logger.warn('[customerHealth] cron run failed', { error: error.message });
    }
  };

  const timer = setInterval(run, intervalMs);
  if (typeof timer.unref === 'function') {
    timer.unref();
  }

  logger.info('[customerHealth] cron scheduled', { intervalMs });
  return timer;
}

module.exports = {
  emitCustomerHealthEvents,
  scheduleCustomerHealthCron
};
