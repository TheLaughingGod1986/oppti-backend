const { getSites } = require('./site');
const { getQuotaStatus, computePeriodStart } = require('./quota');

const FEATURE_LABELS = {
  alt_text: 'OpptiAI Alt Text',
  title_meta: 'OpptiAI Titles'
};

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

function mapSubscription(subscription) {
  const interval = subscription.billing_interval || subscription.billing_cycle || null;
  const mapped = {
    id: subscription.id || subscription.stripe_subscription_id,
    plan_name: subscription.plan_id || subscription.plan || 'free',
    interval: interval === 'monthly' ? 'month' : interval === 'yearly' ? 'year' : interval,
    status: subscription.status || 'active',
    current_period_start: subscription.current_period_start || subscription.created_at || null,
    current_period_end: subscription.current_period_end || subscription.expires_at || null,
    cancel_at_period_end: Boolean(subscription.cancel_at_period_end),
    stripe_subscription_id: subscription.stripe_subscription_id || null
  };

  if (Number.isFinite(Number(subscription.price))) mapped.price = Number(subscription.price);
  if (subscription.currency) mapped.currency = subscription.currency;
  return mapped;
}

function createAccountDashboardService({ supabase, getStripe }) {
  async function listRawSites(account) {
    if (!account?.license_key) return [];
    const result = await getSites(supabase, { licenseKey: account.license_key });
    if (result.error) {
      throw createServiceError(result.error.message || 'Failed to fetch sites');
    }
    return result.data || [];
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

    if (subscriptions.length === 0 && account.plan && account.plan !== 'free') {
      subscriptions = [account];
    }

    return subscriptions.map(mapSubscription);
  }

  async function listPluginStats(account, pluginName) {
    const periodStart = computePeriodStart(account.billing_day_of_month || 1, new Date());
    const periodEnd = new Date(periodStart);
    periodEnd.setUTCMonth(periodEnd.getUTCMonth() + 1);

    let query = supabase
      .from('usage_logs')
      .select('feature_type, credits_used')
      .eq('license_key', account.license_key)
      .gte('created_at', periodStart.toISOString())
      .lt('created_at', periodEnd.toISOString());

    if (pluginName) {
      query = query.eq('feature_type', pluginName);
    }

    const rows = assertQuery(await query, 'Failed to fetch plugin statistics');
    const stats = new Map();

    for (const row of rows) {
      const feature = row.feature_type || 'alt_text';
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

  return {
    async getDashboard(request) {
      const account = getAccount(request);
      const [sites, quota] = await Promise.all([listRawSites(account), getQuota(account)]);
      const [subscriptions, pluginStats] = await Promise.all([
        listSubscriptions(account, sites),
        listPluginStats(account)
      ]);

      return {
        ok: true,
        installations: [],
        subscription: subscriptions[0] || null,
        usage: {
          credits_used: Number(quota.credits_used || 0),
          credits_included: Number(quota.total_limit || 0),
          images_optimized: pluginStats.reduce((total, row) => total + row.images_processed, 0),
          period_start: quota.site_quota?.quota_period_start || computePeriodStart(account.billing_day_of_month || 1).toISOString(),
          period_end: quota.reset_date,
          resetDate: quota.reset_date
        },
        credits: {
          balance: Number(quota.credits_remaining || 0)
        }
      };
    },

    async getSubscriptions(request) {
      const account = getAccount(request);
      return listSubscriptions(account, await listRawSites(account));
    },

    async getSites(request) {
      const sites = await listRawSites(getAccount(request));
      return sites.map((site) => ({
        id: site.id,
        domain: toDomain(site.site_url),
        status: site.status === 'deactivated' ? 'suspended' : (site.status || 'active'),
        license_ids: site.license_key ? [site.license_key] : [],
        created_at: site.created_at || site.activated_at,
        last_connected: site.last_seen_at || site.last_activity_at || null
      }));
    },

    async getPluginStats(request, pluginName) {
      return listPluginStats(getAccount(request), pluginName);
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
      const connections = assertQuery(connectionsResult, 'Failed to fetch plugin connections');
      const statsByLabel = new Map(pluginStats.map((stats) => [stats.plugin_name, stats]));

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
      if (!account.stripe_customer_id) return [];

      const stripe = getStripe();
      if (!stripe?.invoices?.list) {
        throw createServiceError('Billing service is not configured', 503, 'SERVICE_UNAVAILABLE');
      }

      const result = await stripe.invoices.list({ customer: account.stripe_customer_id, limit: 100 });
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
    },

    async getOrganizations(request) {
      const account = getAccount(request);
      const result = await supabase
        .from('organizations')
        .select('id, name, created_at')
        .eq('license_key', account.license_key)
        .order('created_at', { ascending: false });
      const organizations = assertQuery(result, 'Failed to fetch organizations');
      const sites = await listRawSites(account);
      return organizations.map((organization) => ({
        ...organization,
        sites_count: sites.length,
        licenses_count: 1
      }));
    },

    async createOrganization(request, name) {
      const account = getAccount(request);
      const result = await supabase
        .from('organizations')
        .insert({
          name,
          license_key: account.license_key,
          plan: account.plan || 'free',
          max_sites: account.max_sites || 1
        })
        .select('id, name, created_at')
        .single();
      if (result.error) throw createServiceError(result.error.message || 'Failed to create organization');
      return result.data;
    }
  };
}

module.exports = {
  createAccountDashboardService,
  createServiceError,
  mapSubscription,
  toDomain
};
