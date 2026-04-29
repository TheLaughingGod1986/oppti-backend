const express = require('express');
const request = require('supertest');

jest.mock('../../services/siteQuota', () => ({
  reconcileBillingEntitlement: jest.fn(),
  resolveCanonicalSite: jest.fn(),
  selectActiveSiteSubscription: jest.fn(),
  syncLegacySitePointers: jest.fn()
}));

const logger = require('../../lib/logger');
const {
  resolveCanonicalSite,
  selectActiveSiteSubscription
} = require('../../services/siteQuota');
const { createBillingRouter } = require('../../routes/billing');

function createSelectQuery(rows, { error = null } = {}) {
  const filters = [];
  let sort = null;
  let limitCount = null;

  const execute = () => {
    let result = [...rows];

    for (const filter of filters) {
      result = result.filter(filter);
    }

    if (sort) {
      const { column, ascending, nullsFirst } = sort;
      result.sort((left, right) => {
        const leftValue = left[column] ?? null;
        const rightValue = right[column] ?? null;

        if (leftValue === rightValue) return 0;
        if (leftValue === null) return nullsFirst ? -1 : 1;
        if (rightValue === null) return nullsFirst ? 1 : -1;

        if (leftValue > rightValue) return ascending ? 1 : -1;
        if (leftValue < rightValue) return ascending ? -1 : 1;
        return 0;
      });
    }

    if (typeof limitCount === 'number') {
      result = result.slice(0, limitCount);
    }

    return result;
  };

  const query = {
    eq(column, value) {
      filters.push((row) => row[column] === value);
      return query;
    },
    in(column, values) {
      filters.push((row) => values.includes(row[column]));
      return query;
    },
    order(column, { ascending = true, nullsFirst = false } = {}) {
      sort = { column, ascending, nullsFirst };
      return query;
    },
    limit(count) {
      limitCount = count;
      return query;
    },
    maybeSingle: jest.fn().mockImplementation(() => Promise.resolve({
      data: execute()[0] || null,
      error
    })),
    single: jest.fn().mockImplementation(() => Promise.resolve({
      data: execute()[0] || null,
      error
    })),
    then(resolve, reject) {
      return Promise.resolve({
        data: execute(),
        error
      }).then(resolve, reject);
    }
  };

  return query;
}

function createSupabaseMock({
  siteSubscriptions = [],
  sites = [],
  licenses = [],
  throwOnLegacySubscriptions = true
} = {}) {
  return {
    from(table) {
      if (table === 'subscriptions') {
        if (throwOnLegacySubscriptions) {
          throw new Error('legacy subscriptions table should not be read');
        }
        return {
          select: () => createSelectQuery([])
        };
      }

      if (table === 'site_subscriptions') {
        return {
          select: () => createSelectQuery(siteSubscriptions)
        };
      }

      if (table === 'sites') {
        return {
          select: () => createSelectQuery(sites)
        };
      }

      if (table === 'licenses') {
        return {
          select: () => createSelectQuery(licenses)
        };
      }

      throw new Error(`Unexpected table: ${table}`);
    }
  };
}

function createApp({ supabase, license = null, user = null, requiredToken = null }) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.license = license;
    req.user = user;
    next();
  });
  app.use('/billing', createBillingRouter({
    supabase,
    requiredToken,
    getStripe: () => null,
    priceIds: {
      pro: 'price_pro',
      agency: 'price_agency',
      credits: 'price_credits'
    }
  }));
  return app;
}

describe('billing truth-source cleanup', () => {
  let infoSpy;
  let warnSpy;
  let errorSpy;

  beforeEach(() => {
    jest.clearAllMocks();
    infoSpy = jest.spyOn(logger, 'info').mockImplementation(() => {});
    warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {});
    errorSpy = jest.spyOn(logger, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    infoSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  test('GET /billing/info resolves a free account from licenses without touching legacy subscriptions', async () => {
    const app = createApp({
      supabase: createSupabaseMock(),
      license: {
        id: 'acct_free',
        license_key: 'lic_free',
        plan: 'free',
        status: 'active',
        billing_cycle: 'monthly'
      }
    });

    const response = await request(app).get('/billing/info');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      success: true,
      data: {
        billing: {
          plan: 'free',
          status: 'active',
          billingCycle: 'monthly',
          nextBillingDate: null,
          subscriptionId: null,
          cancelAtPeriodEnd: false,
          customerId: null
        }
      }
    });
    expect(infoSpy).toHaveBeenCalledWith('[billing] info_source_resolved', expect.objectContaining({
      source: 'licenses',
      resolution_path: 'license',
      account_id: 'acct_free',
      licenseKeyPrefix: '[redacted]',
      stripe_subscription_id: null
    }));
  });

  test('GET /billing/info prefers V2 site_subscriptions via stripe subscription id', async () => {
    const app = createApp({
      supabase: createSupabaseMock({
        siteSubscriptions: [
          {
            id: 'site_sub_1',
            site_id: 'site_1',
            plan_id: 'agency',
            stripe_customer_id: 'cus_123',
            stripe_subscription_id: 'sub_123',
            status: 'past_due',
            billing_interval: 'year',
            current_period_end: '2026-07-01T00:00:00.000Z',
            cancel_at_period_end: true
          }
        ]
      }),
      license: {
        id: 'acct_paid',
        license_key: 'lic_paid',
        plan: 'pro',
        status: 'active',
        billing_cycle: 'monthly',
        stripe_customer_id: 'cus_123',
        stripe_subscription_id: 'sub_123'
      }
    });

    const response = await request(app).get('/billing/info');

    expect(response.status).toBe(200);
    expect(response.body.data.billing).toEqual({
      plan: 'agency',
      status: 'past_due',
      billingCycle: 'yearly',
      nextBillingDate: '2026-07-01T00:00:00.000Z',
      subscriptionId: 'sub_123',
      cancelAtPeriodEnd: true,
      customerId: 'cus_123'
    });
    expect(infoSpy).toHaveBeenCalledWith('[billing] info_source_resolved', expect.objectContaining({
      source: 'site_subscriptions',
      resolution_path: 'stripe_subscription_id',
      account_id: 'acct_paid',
      licenseKeyPrefix: '[redacted]',
      stripe_subscription_id: 'sub_123'
    }));
  });

  test('GET /billing/info can resolve V2 billing state through sites linked to the license key', async () => {
    const app = createApp({
      supabase: createSupabaseMock({
        sites: [
          { id: 'site_linked', license_key: 'lic_linked' }
        ],
        siteSubscriptions: [
          {
            id: 'site_sub_linked',
            site_id: 'site_linked',
            plan_id: 'pro',
            stripe_customer_id: 'cus_linked',
            stripe_subscription_id: 'sub_linked',
            status: 'active',
            billing_interval: 'month',
            current_period_end: '2026-06-15T00:00:00.000Z',
            cancel_at_period_end: false
          }
        ]
      }),
      license: {
        id: 'acct_linked',
        license_key: 'lic_linked',
        plan: 'free',
        status: 'active',
        billing_cycle: 'monthly'
      }
    });

    const response = await request(app).get('/billing/info');

    expect(response.status).toBe(200);
    expect(response.body.data.billing).toEqual({
      plan: 'pro',
      status: 'active',
      billingCycle: 'monthly',
      nextBillingDate: '2026-06-15T00:00:00.000Z',
      subscriptionId: 'sub_linked',
      cancelAtPeriodEnd: false,
      customerId: 'cus_linked'
    });
    expect(infoSpy).toHaveBeenCalledWith('[billing] info_source_resolved', expect.objectContaining({
      source: 'site_subscriptions',
      resolution_path: 'license_sites',
      account_id: 'acct_linked',
      licenseKeyPrefix: 'lic_link...',
      stripe_subscription_id: 'sub_linked'
    }));
  });

  test('GET /billing/subscription still resolves paid state from V2 site_subscriptions first', async () => {
    resolveCanonicalSite.mockResolvedValue({
      site: {
        id: 'site_paid',
        site_hash: 'site_hash_paid',
        license_key: 'lic_paid'
      }
    });
    selectActiveSiteSubscription.mockResolvedValue({
      plan_id: 'agency',
      status: 'active',
      billing_interval: 'month',
      current_period_end: '2026-05-20T00:00:00.000Z',
      stripe_subscription_id: 'sub_paid',
      cancel_at_period_end: false
    });

    const app = createApp({
      supabase: createSupabaseMock({
        licenses: [
          {
            license_key: 'lic_paid',
            plan: 'pro',
            status: 'active',
            billing_cycle: 'monthly',
            stripe_subscription_id: 'sub_paid'
          }
        ]
      }),
      license: {
        id: 'acct_paid',
        license_key: 'lic_paid'
      }
    });

    const response = await request(app)
      .get('/billing/subscription')
      .set('X-Site-Key', 'site_hash_paid');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      success: true,
      data: {
        plan: 'agency',
        status: 'active',
        billingCycle: 'month',
        nextBillingDate: '2026-05-20T00:00:00.000Z',
        subscriptionId: 'sub_paid',
        cancelAtPeriodEnd: false
      }
    });
    expect(infoSpy).toHaveBeenCalledWith('[billing] subscription_source_resolved', expect.objectContaining({
      source: 'site_subscriptions',
      site_id: 'site_paid',
      site_hash: 'site_hash_paid',
      stripe_subscription_id: 'sub_paid'
    }));
    expect(resolveCanonicalSite).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        createIfMissing: true,
        legacyLicenseKey: 'lic_paid'
      })
    );
  });

  test('GET /billing/subscription falls back to licenses for free state when no active site subscription exists', async () => {
    resolveCanonicalSite.mockResolvedValue({
      site: {
        id: 'site_free',
        site_hash: 'site_hash_free',
        license_key: 'lic_free'
      }
    });
    selectActiveSiteSubscription.mockResolvedValue(null);

    const app = createApp({
      supabase: createSupabaseMock({
        licenses: [
          {
            license_key: 'lic_free',
            plan: 'free',
            status: 'active',
            billing_cycle: 'monthly',
            stripe_subscription_id: null
          }
        ]
      }),
      license: {
        id: 'acct_free',
        license_key: 'lic_free'
      }
    });

    const response = await request(app)
      .get('/billing/subscription')
      .set('X-Site-Key', 'site_hash_free');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      success: true,
      data: {
        plan: 'free',
        status: 'active',
        billingCycle: 'monthly',
        nextBillingDate: null,
        subscriptionId: null,
        cancelAtPeriodEnd: false
      }
    });
    expect(infoSpy).toHaveBeenCalledWith('[billing] subscription_source_resolved', expect.objectContaining({
      source: 'licenses',
      site_id: 'site_free',
      site_hash: 'site_hash_free',
      stripe_subscription_id: null
    }));
  });
});
