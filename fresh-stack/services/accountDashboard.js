const { getSites, deactivateSite } = require('./site');
const { getQuotaStatus, computePeriodStart } = require('./quota');
const { getLimits } = require('./planLimits');
const { recordPluginConnection } = require('./pluginConnections');

const FEATURE_LABELS = {
  alt_text: 'OpptiAI Alt Text',
  title_meta: 'OpptiAI Titles'
};

const LABEL_TO_FEATURE = Object.fromEntries(
  Object.entries(FEATURE_LABELS).map(([id, label]) => [label, id])
);

function createServiceError(message, status = 500, code = 'SERVER_ERROR') {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function assertQuery(result, message) {
  if (result?.error) {
    throw createServiceError(result.error.message || message);
  }
  return result?.data || [];
}

function getAccount(request) {
  return request.user || request.license || null;
}

function toDomain(siteUrl) {
  if (!siteUrl) return '';
  try {
    return new URL(siteUrl).hostname;
  } catch (_error) {
    return String(siteUrl);
  }
}

function formatPlanName(planId) {
  const raw = String(planId || 'free').trim();
  if (!raw || raw.toLowerCase() === 'free') return 'Free';
  return raw
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function mapSubscription(subscription) {
  const interval = subscription.billing_interval || subscription.billing_cycle || null;
  const planId = subscription.plan_id || subscription.plan || 'free';
  const mapped = {
    id: subscription.id || subscription.stripe_subscription_id || `plan-${planId}`,
    plan_name: formatPlanName(planId),
    interval: interval === 'monthly' ? 'month' : interval === 'yearly' ? 'year' : interval,
    status: subscription.status || 'active',
    current_period_start: subscription.current_period_start || subscription.created_at || null,
    current_period_end: subscription.current_period_end || subscription.expires_at || null,
    cancel_at_period_end: Boolean(subscription.cancel_at_period_end),
    stripe_subscription_id: subscription.stripe_subscription_id || null
  };

  if (Number.isFinite(Number(subscription.price))) {
    mapped.price = Number(subscription.price);
  } else if (String(planId).toLowerCase() === 'free') {
    mapped.price = 0;
    mapped.currency = subscription.currency || 'gbp';
  }
  if (subscription.currency) mapped.currency = subscription.currency;
  return mapped;
}

function getBillingPeriod(account, now = new Date()) {
  const periodStart = computePeriodStart(account?.billing_day_of_month || 1, now);
  const periodEnd = new Date(periodStart);
  periodEnd.setUTCMonth(periodEnd.getUTCMonth() + 1);
  return { periodStart, periodEnd };
}

function buildAccountPlanSubscription(account) {
  return {
    id: account.id || 'account-plan',
    plan: account.plan || 'free',
    plan_id: account.plan || 'free',
    status: account.status || 'active',
    created_at: account.created_at || null,
    expires_at: account.expires_at || null,
    stripe_subscription_id: account.stripe_subscription_id || null,
    price: account.plan && account.plan !== 'free' ? account.price : 0,
    currency: account.currency || 'gbp'
  };
}

function aggregatePluginStats(rows, pluginName) {
  const stats = new Map();

  for (const row of rows) {
    const feature = row.feature_type || 'alt_text';
    if (pluginName && feature !== pluginName) continue;

    const current = stats.get(feature) || {
      plugin_name: FEATURE_LABELS[feature] || feature,
      credits_used: 0,
      images_processed: 0
    };
    current.credits_used += Number(row.credits_used || 1);
    current.images_processed += 1;
    if (feature === 'alt_text') current.alt_text_generated = current.images_processed;
    if (feature === 'title_meta') current.meta_tags_generated = current.images_processed;
    stats.set(feature, current);
  }

  return [...stats.values()];
}

function createAccountDashboardService({ supabase, getStripe }) {
  async function listRawSites(account) {
    if (!account?.license_key && !account?.id) return [];
    if (!account?.license_key) return [];
    const result = await getSites(supabase, { licenseKey: account.license_key });
    if (result.error) {
      throw createServiceError(result.error.message || 'Failed to fetch sites');
    }
    return result.data || [];
  }

  /**
   * Account-level usage across every linked site/plugin.
   * Memberships can attach sites that don't all share the same license_key on
   * every historical usage_logs row, so query by license_key, license_id, and
   * site_hash and de-dupe by row id.
   */
  async function listUsageLogRows(account, sites = []) {
    const { periodStart, periodEnd } = getBillingPeriod(account);
    const siteHashes = [...new Set(
      (sites || []).map((site) => site.site_hash).filter(Boolean)
    )];

    const filters = [];
    if (account?.license_key) {
      filters.push(`license_key.eq.${account.license_key}`);
    }
    if (account?.id) {
      filters.push(`license_id.eq.${account.id}`);
    }
    if (siteHashes.length > 0) {
      filters.push(`site_hash.in.(${siteHashes.join(',')})`);
    }

    if (filters.length === 0) {
      return { rows: [], periodStart, periodEnd };
    }

    const result = await supabase
      .from('usage_logs')
      .select('id, feature_type, credits_used, site_hash, license_key, license_id')
      .or(filters.join(','))
      .gte('created_at', periodStart.toISOString())
      .lt('created_at', periodEnd.toISOString());

    const rows = assertQuery(result, 'Failed to fetch account usage logs');
    const deduped = new Map();
    for (const row of rows) {
      const key = row.id || `${row.site_hash || 'none'}:${row.feature_type || 'alt_text'}:${row.credits_used}`;
      if (!deduped.has(key)) deduped.set(key, row);
    }

    return { rows: [...deduped.values()], periodStart, periodEnd };
  }

  async function getAccountUsage(account, sites = []) {
    const limits = getLimits(account?.plan || 'free');
    const { rows, periodStart, periodEnd } = await listUsageLogRows(account, sites);
    const creditsUsed = rows.reduce((sum, row) => sum + Number(row.credits_used || 1), 0);
    const creditsIncluded = Number(limits.credits || 0);
    const creditsRemaining = Math.max(creditsIncluded - creditsUsed, 0);

    return {
      credits_used: creditsUsed,
      credits_included: creditsIncluded,
      credits_remaining: creditsRemaining,
      images_optimized: rows.length,
      period_start: periodStart.toISOString(),
      period_end: periodEnd.toISOString(),
      reset_date: periodEnd.toISOString(),
      rows
    };
  }

  async function getQuota(account) {
    const result = await getQuotaStatus(supabase, {
      account,
      licenseKey: account.license_key,
      accountId: account.id
    });
    if (result?.error) {
      throw createServiceError(
        result.message || 'Failed to fetch account usage',
        result.status || 500,
        result.code || result.error
      );
    }
    return result;
  }

  async function listSubscriptions(account, sites) {
    const siteIds = sites.map((site) => site.id).filter(Boolean);
    let subscriptions = [];

    if (siteIds.length > 0) {
      const result = await supabase
        .from('site_subscriptions')
        .select('id, site_id, plan_id, stripe_customer_id, stripe_subscription_id, status, billing_interval, current_period_start, current_period_end, cancel_at_period_end, created_at')
        .in('site_id', siteIds)
        .order('created_at', { ascending: false });
      subscriptions = assertQuery(result, 'Failed to fetch subscriptions');
    }

    if (subscriptions.length === 0 && account.stripe_subscription_id) {
      const result = await supabase
        .from('site_subscriptions')
        .select('id, site_id, plan_id, stripe_customer_id, stripe_subscription_id, status, billing_interval, current_period_start, current_period_end, cancel_at_period_end, created_at')
        .eq('stripe_subscription_id', account.stripe_subscription_id)
        .limit(1);
      subscriptions = assertQuery(result, 'Failed to fetch subscription');
    }

    const mapped = subscriptions.map(mapSubscription);
    const activePaid = mapped.filter((sub) => (
      (sub.status === 'active' || sub.status === 'trialing')
      && Boolean(sub.stripe_subscription_id)
    ));

    // Prefer a live Stripe subscription when present; otherwise surface the
    // account plan (free/pro/etc.) so the dashboard never looks plan-less.
    if (activePaid.length > 0) {
      return activePaid;
    }

    if (account) {
      return [mapSubscription(buildAccountPlanSubscription(account))];
    }

    return mapped;
  }

  async function listPluginStats(account, pluginName, sites = null) {
    const resolvedSites = Array.isArray(sites) ? sites : await listRawSites(account);
    const { rows } = await listUsageLogRows(account, resolvedSites);
    return aggregatePluginStats(rows, pluginName);
  }

  return {
    async getDashboard(request) {
      const account = getAccount(request);
      let sites = [];
      try {
        sites = await listRawSites(account);
      } catch (_error) {
        sites = [];
      }

      let usageSummary;
      try {
        usageSummary = await getAccountUsage(account, sites);
      } catch (_error) {
        const { periodStart, periodEnd } = getBillingPeriod(account);
        const limits = getLimits(account?.plan || 'free');
        usageSummary = {
          credits_used: 0,
          credits_included: Number(limits.credits || 0),
          credits_remaining: Number(limits.credits || 0),
          images_optimized: 0,
          period_start: periodStart.toISOString(),
          period_end: periodEnd.toISOString(),
          reset_date: periodEnd.toISOString(),
          rows: []
        };
      }

      let subscriptions = [];
      try {
        subscriptions = await listSubscriptions(account, sites);
      } catch (_error) {
        subscriptions = account ? [mapSubscription(buildAccountPlanSubscription(account))] : [];
      }

      const pluginStats = aggregatePluginStats(usageSummary.rows || []);

      // Optional enrichment from legacy quota path (purchased credit balance).
      let creditBalance = usageSummary.credits_remaining;
      try {
        const quota = await getQuota(account);
        if (Number.isFinite(Number(quota?.credits_remaining))) {
          creditBalance = Number(quota.credits_remaining);
        }
      } catch (_error) {
        // Account usage summary is enough for the overview cards.
      }

      return {
        ok: true,
        installations: [],
        subscription: subscriptions[0] || null,
        usage: {
          credits_used: Number(usageSummary.credits_used || 0),
          credits_included: Number(usageSummary.credits_included || 0),
          images_optimized: Number(
            pluginStats.reduce((total, row) => total + row.images_processed, 0)
            || usageSummary.images_optimized
            || 0
          ),
          time_saved_hours: Number(
            ((pluginStats.reduce((total, row) => total + row.images_processed, 0) || 0) * 0.05).toFixed(1)
          ),
          period_start: usageSummary.period_start,
          period_end: usageSummary.period_end,
          resetDate: usageSummary.reset_date
        },
        credits: {
          balance: Number(creditBalance || 0)
        }
      };
    },

    async getSubscriptions(request) {
      const account = getAccount(request);
      return listSubscriptions(account, await listRawSites(account));
    },

    async getSites(request) {
      const account = getAccount(request);
      const sites = await listRawSites(account);
      let usageRows = [];
      try {
        ({ rows: usageRows } = await listUsageLogRows(account, sites));
      } catch (_error) {
        usageRows = [];
      }

      const usageBySite = new Map();
      for (const row of usageRows) {
        const siteHash = row.site_hash;
        if (!siteHash) continue;
        const feature = row.feature_type || 'alt_text';
        const current = usageBySite.get(siteHash) || new Map();
        current.set(feature, (current.get(feature) || 0) + Number(row.credits_used || 1));
        usageBySite.set(siteHash, current);
      }

      // Prefer connected plugins as the zero-usage fallback so a linked site
      // still shows real plugin names before the first generation this period.
      let connectedPluginIds = ['alt_text'];
      try {
        if (account?.id) {
          const connectionsResult = await supabase
            .from('account_plugin_connections')
            .select('plugin_id')
            .eq('license_id', account.id);
          const connections = assertQuery(connectionsResult, 'Failed to fetch plugin connections');
          if (connections.length > 0) {
            connectedPluginIds = [...new Set(
              connections.map((row) => row.plugin_id).filter(Boolean)
            )];
          }
        }
      } catch (_error) {
        connectedPluginIds = ['alt_text'];
      }

      return sites.map((site) => {
        const siteUsage = usageBySite.get(site.site_hash) || new Map();
        const plugins = [];

        for (const [feature, creditsUsed] of siteUsage.entries()) {
          plugins.push({
            plugin_id: feature,
            plugin_name: FEATURE_LABELS[feature] || feature,
            credits_used: creditsUsed
          });
        }

        if (plugins.length === 0 && (site.license_key || account?.license_key)) {
          for (const pluginId of connectedPluginIds) {
            plugins.push({
              plugin_id: pluginId,
              plugin_name: FEATURE_LABELS[pluginId] || pluginId,
              credits_used: 0
            });
          }
        }

        plugins.sort((a, b) => b.credits_used - a.credits_used || a.plugin_name.localeCompare(b.plugin_name));
        const creditsUsed = plugins.reduce((total, plugin) => total + plugin.credits_used, 0);

        return {
          id: site.id,
          domain: toDomain(site.site_url),
          status: site.status === 'deactivated' ? 'suspended' : (site.status || 'active'),
          site_hash: site.site_hash || null,
          license_ids: account?.id ? [account.id] : (site.license_key ? [site.license_key] : []),
          plugins,
          credits_used: creditsUsed,
          created_at: site.created_at || site.activated_at,
          last_connected: site.last_seen_at || site.last_activity_at || null
        };
      });
    },

    async getPluginStats(request, pluginName) {
      const account = getAccount(request);
      const sites = await listRawSites(account);
      return listPluginStats(account, pluginName, sites);
    },

    async detachSite(request) {
      const account = getAccount(request);
      const siteId = typeof request.body?.site_id === 'string' ? request.body.site_id.trim() : '';
      if (!siteId) {
        throw createServiceError('site_id is required', 400, 'VALIDATION_ERROR');
      }
      if (!account?.license_key) {
        throw createServiceError('Account license is required', 400, 'VALIDATION_ERROR');
      }

      const sites = await listRawSites(account);
      const site = sites.find((row) => row.id === siteId);
      if (!site?.site_hash) {
        throw createServiceError('Site not found on this account', 404, 'SITE_NOT_FOUND');
      }

      const result = await deactivateSite(supabase, {
        licenseKey: account.license_key,
        siteHash: site.site_hash
      });
      if (result?.error) {
        throw createServiceError(
          result.message || 'Failed to detach site',
          result.status || 500,
          result.error
        );
      }

      return {
        ok: true,
        site_id: siteId,
        site_hash: site.site_hash
      };
    },

    async getLicenses(request) {
      const account = getAccount(request);
      const [sites, pluginStats, connectionsResult] = await Promise.all([
        listRawSites(account),
        listPluginStats(account),
        supabase
          .from('account_plugin_connections')
          .select('id, plugin_id, first_connected_at')
          .eq('license_id', account.id)
          .order('first_connected_at', { ascending: true })
      ]);
      let connections = assertQuery(connectionsResult, 'Failed to fetch plugin connections');
      const statsByLabel = new Map(pluginStats.map((stats) => [stats.plugin_name, stats]));

      // Older accounts may have usage/sites but no account_plugin_connections row
      // (connection writes used to be gated on Loops). Self-heal so My Plugins is not blank.
      if (connections.length === 0 && account?.id) {
        const pluginIds = new Set();
        for (const stats of pluginStats) {
          const fromLabel = LABEL_TO_FEATURE[stats.plugin_name];
          if (fromLabel) pluginIds.add(fromLabel);
        }
        if (sites.length > 0 || pluginStats.length > 0 || account.license_key) {
          pluginIds.add('alt_text');
        }
        for (const pluginId of pluginIds) {
          await recordPluginConnection(supabase, {
            accountId: account.id,
            pluginId
          });
        }
        if (pluginIds.size > 0) {
          const healed = await supabase
            .from('account_plugin_connections')
            .select('id, plugin_id, first_connected_at')
            .eq('license_id', account.id)
            .order('first_connected_at', { ascending: true });
          connections = assertQuery(healed, 'Failed to fetch plugin connections');
        }
      }

      if (connections.length === 0 && account?.license_key) {
        return [
          {
            id: account.id,
            plugin_name: FEATURE_LABELS.alt_text,
            license_key: account.license_key,
            status: account.status || 'active',
            sites_count: sites.length,
            credits_used_this_month: Number(statsByLabel.get(FEATURE_LABELS.alt_text)?.credits_used || 0),
            created_at: account.created_at || new Date().toISOString(),
            expires_at: account.expires_at || null
          }
        ];
      }

      return connections.map((connection) => {
        const pluginName = FEATURE_LABELS[connection.plugin_id] || connection.plugin_id;
        return {
          id: connection.id,
          plugin_name: pluginName,
          license_key: account.license_key,
          status: account.status,
          sites_count: sites.length,
          credits_used_this_month: Number(statsByLabel.get(pluginName)?.credits_used || 0),
          created_at: connection.first_connected_at,
          expires_at: account.expires_at || null
        };
      });
    },

    async getInvoices(request) {
      const account = getAccount(request);
      if (!account?.stripe_customer_id) return [];

      const stripe = getStripe();
      if (!stripe?.invoices?.list) {
        // Free / non-Stripe accounts should still get an empty invoices page.
        return [];
      }

      try {
        const result = await Promise.race([
          stripe.invoices.list({ customer: account.stripe_customer_id, limit: 100 }),
          new Promise((_, reject) => {
            setTimeout(() => reject(new Error('Stripe invoices list timed out')), 8000);
          })
        ]);
        return (result.data || []).map((invoice) => ({
          id: invoice.id,
          amount: invoice.amount_paid ?? invoice.amount_due ?? 0,
          currency: invoice.currency,
          status: invoice.status,
          created: new Date(invoice.created * 1000).toISOString(),
          invoice_pdf: invoice.invoice_pdf || null,
          hosted_invoice_url: invoice.hosted_invoice_url || null,
          description: invoice.description || null
        }));
      } catch (_error) {
        // Never leave the dashboard invoices page hanging on Stripe failures.
        return [];
      }
    },

    async getOrganizations() {
      // Organizations were removed when the V2 account model made one license
      // the account/workspace boundary. Keep the historical endpoint empty-safe
      // for older clients without querying the retired table.
      return [];
    },

    async createOrganization() {
      throw createServiceError(
        'Organizations are managed through the account license and connected sites',
        410,
        'ORGANIZATIONS_RETIRED'
      );
    }
  };
}

module.exports = {
  createAccountDashboardService,
  createServiceError,
  mapSubscription,
  toDomain,
  aggregatePluginStats,
  getBillingPeriod
};
