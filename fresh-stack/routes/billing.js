const express = require('express');
const crypto = require('crypto');
const logger = require('../lib/logger');
const { verifyWebhookSignature } = require('../lib/stripe');
const { captureServerEvent, identifyServerUser } = require('../lib/posthog');
const { trackPlanUpgraded } = require('../../src/services/loops');
const { buildSiteIdentity } = require('../lib/siteIdentity');
const {
  reconcileBillingEntitlement,
  resolveCanonicalSite,
  selectActiveSiteSubscription,
  syncLegacySitePointers
} = require('../services/siteQuota');
const { getBillingPlansJson, getBillingPlansJsonLive, buildPlansList } = require('../services/billingPlansCatalog');

const ACCOUNT_SELECT = 'id, email, license_key, stripe_customer_id, stripe_subscription_id, plan, billing_cycle';
const SITE_SELECT = 'id, site_hash, license_key, site_url, site_name, status';
const SITE_SUBSCRIPTION_SELECT = 'id, site_id, plan_id, stripe_customer_id, stripe_subscription_id, status, billing_interval, current_period_start, current_period_end, cancel_at_period_end, canceled_at';
const ACTIVE_BILLING_STATUSES = ['active', 'trialing', 'past_due'];
const INACTIVE_BILLING_STATUSES = ['canceled', 'incomplete_expired', 'unpaid'];
const ZERO_DECIMAL_CURRENCIES = new Set([
  'bif', 'clp', 'djf', 'gnf', 'jpy', 'kmf', 'krw', 'mga', 'pyg',
  'rwf', 'ugx', 'vnd', 'vuv', 'xaf', 'xof', 'xpf'
]);
const PURCHASE_TYPES = new Set([
  'new_purchase',
  'upgrade',
  'renewal',
  'credit_top_up',
  'unknown'
]);
const STRIPE_METADATA_MAX_LENGTH = 500;
const CHECKOUT_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const checkoutRateBuckets = new Map();

function normalizeStripeId(value) {
  if (typeof value === 'string' && value) return value;
  if (value && typeof value === 'object' && typeof value.id === 'string' && value.id) {
    return value.id;
  }
  return null;
}

function resolvePlanFromPriceId(priceIds = {}, priceId) {
  if (!priceId) return null;
  const match = Object.entries(priceIds).find(([, configuredPriceId]) => configuredPriceId === priceId);
  return match ? match[0] : null;
}

function normalizePlanValue(plan) {
  if (plan === undefined || plan === null) return null;
  const normalized = String(plan).trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === 'growth') return 'pro';
  return normalized;
}

function normalizeCurrency(currency) {
  if (typeof currency !== 'string' || !currency.trim()) return null;
  return currency.trim().toLowerCase();
}

function normalizePurchaseType(purchaseType) {
  if (purchaseType === undefined || purchaseType === null) return null;
  const normalized = String(purchaseType).trim().toLowerCase();
  return PURCHASE_TYPES.has(normalized) ? normalized : null;
}

function resolveAmount(amountMinor, currency) {
  if (typeof amountMinor !== 'number') return null;
  const normalizedCurrency = normalizeCurrency(currency) || '';
  if (ZERO_DECIMAL_CURRENCIES.has(normalizedCurrency)) {
    return amountMinor;
  }
  return amountMinor / 100;
}

function extractMetadataValue(metadata = {}, keys = []) {
  for (const key of keys) {
    const value = metadata[key];
    if (typeof value === 'string' && value) {
      return value;
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      return String(value);
    }
  }
  return null;
}

function extractMetadataBoolean(metadata = {}, keys = []) {
  for (const key of keys) {
    const value = metadata[key];
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      if (['true', '1', 'yes'].includes(normalized)) return true;
      if (['false', '0', 'no'].includes(normalized)) return false;
    }
  }
  return null;
}

function sanitizeStripeMetadataValue(value, { maxLength = STRIPE_METADATA_MAX_LENGTH, lowercase = false } = {}) {
  if (value === undefined || value === null) return undefined;

  const normalized = String(value)
    .replace(/[\u0000-\u001F\u007F]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!normalized) return undefined;

  const sanitized = lowercase ? normalized.toLowerCase() : normalized;
  return sanitized.slice(0, maxLength);
}

function maskSecret(value) {
  if (!value) return null;
  const stringValue = String(value);
  return stringValue.length <= 8 ? '[redacted]' : `${stringValue.slice(0, 8)}...`;
}

function getClientIp(req) {
  return req.ip
    || req.headers['x-forwarded-for']?.split(',')[0]?.trim()
    || req.connection?.remoteAddress
    || 'unknown-ip';
}

function getCheckoutRateLimit(selectedPlanId) {
  const defaultLimit = selectedPlanId === 'credits' ? 3 : 6;
  const configured = Number(
    selectedPlanId === 'credits'
      ? process.env.CHECKOUT_CREDITS_RATE_LIMIT_PER_15_MIN
      : process.env.CHECKOUT_RATE_LIMIT_PER_15_MIN
  );
  return Number.isFinite(configured) && configured > 0 ? configured : defaultLimit;
}

function pruneCheckoutRateBuckets(now = Date.now()) {
  for (const [key, hits] of checkoutRateBuckets.entries()) {
    const recent = hits.filter((timestamp) => now - timestamp < CHECKOUT_RATE_LIMIT_WINDOW_MS);
    if (recent.length) {
      checkoutRateBuckets.set(key, recent);
    } else {
      checkoutRateBuckets.delete(key);
    }
  }
}

function checkCheckoutRateLimit(req, { siteKey, priceId, selectedPlanId }) {
  const now = Date.now();
  pruneCheckoutRateBuckets(now);

  const limit = getCheckoutRateLimit(selectedPlanId);
  const ip = getClientIp(req);
  const account = req.license || req.user || null;
  const accountKey = account?.id || account?.license_key || 'no-account';
  const bucketKey = [
    'checkout',
    selectedPlanId || 'unknown-plan',
    priceId || 'unknown-price',
    siteKey || 'unknown-site',
    accountKey,
    ip
  ].join(':');
  const hits = checkoutRateBuckets.get(bucketKey) || [];
  hits.push(now);
  checkoutRateBuckets.set(bucketKey, hits);

  return {
    allowed: hits.length <= limit,
    count: hits.length,
    limit,
    retryAfterSeconds: Math.ceil(CHECKOUT_RATE_LIMIT_WINDOW_MS / 1000)
  };
}

function buildCheckoutIdempotencyKey({ licenseKey, siteId, priceId, billingCycle, attemptId }) {
  const stablePayload = [
    licenseKey || 'anonymous',
    siteId || 'unknown-site',
    priceId || 'unknown-price',
    billingCycle || 'unknown-cycle'
  ];
  if (attemptId) {
    stablePayload.push(attemptId);
  }
  const payload = stablePayload.join(':');
  return `checkout:${crypto.createHash('sha256').update(payload).digest('hex')}`;
}

function mergeStripeMetadata(...metadataSources) {
  return metadataSources.reduce((merged, metadata) => {
    if (!metadata || typeof metadata !== 'object') {
      return merged;
    }

    for (const [key, value] of Object.entries(metadata)) {
      if (merged[key] !== undefined) continue;

      const sanitizedValue = sanitizeStripeMetadataValue(value);
      if (sanitizedValue !== undefined) {
        merged[key] = sanitizedValue;
      }
    }

    return merged;
  }, {});
}

function normalizeCheckoutAttribution(body = {}) {
  const targetPlan = sanitizeStripeMetadataValue(body.target_plan);

  return {
    accountId: sanitizeStripeMetadataValue(body.account_id),
    userId: sanitizeStripeMetadataValue(body.user_id),
    licenseKey: sanitizeStripeMetadataValue(body.license_key),
    siteId: sanitizeStripeMetadataValue(body.site_id),
    siteHash: sanitizeStripeMetadataValue(body.site_hash),
    email: sanitizeStripeMetadataValue(body.email, { lowercase: true }),
    triggerFeature: sanitizeStripeMetadataValue(body.trigger_feature),
    triggerLocation: sanitizeStripeMetadataValue(body.trigger_location),
    sourcePage: sanitizeStripeMetadataValue(body.source_page),
    targetPlan: normalizePlanValue(targetPlan) || targetPlan,
    source: sanitizeStripeMetadataValue(body.source)
  };
}

function resolveAttributionProperties(metadata = {}) {
  return {
    trigger_feature: extractMetadataValue(metadata, ['trigger_feature', 'triggerFeature']),
    trigger_location: extractMetadataValue(metadata, ['trigger_location', 'triggerLocation']),
    source_page: extractMetadataValue(metadata, ['source_page', 'sourcePage']),
    target_plan: extractMetadataValue(metadata, ['target_plan', 'targetPlan'])
  };
}

function resolveStripeSecretMode(secretKey = process.env.STRIPE_SECRET_KEY || '') {
  if (secretKey.startsWith('sk_live_') || secretKey.startsWith('rk_live_')) return 'live';
  if (secretKey.startsWith('sk_test_') || secretKey.startsWith('rk_test_')) return 'test';
  return 'unknown';
}

function isStripeModeCompatible(livemode) {
  const keyMode = resolveStripeSecretMode();
  if (keyMode === 'unknown') return true;
  return livemode ? keyMode === 'live' : keyMode === 'test';
}

function resolveBillingPeriodFromInterval(interval) {
  if (interval === 'month') return 'monthly';
  if (interval === 'year') return 'yearly';
  return null;
}

function inferPurchaseType({
  eventType,
  paymentMode,
  stripeSubscriptionId,
  billingReason,
  plan,
  currentPlan,
  metadataPurchaseType
}) {
  const explicitPurchaseType = normalizePurchaseType(metadataPurchaseType);
  if (explicitPurchaseType && explicitPurchaseType !== 'unknown') {
    return explicitPurchaseType;
  }

  const normalizedPlan = normalizePlanValue(plan);
  const normalizedCurrentPlan = normalizePlanValue(currentPlan);
  const hasExistingPaidPlan = Boolean(
    normalizedCurrentPlan
    && !['free', 'credits'].includes(normalizedCurrentPlan)
  );
  const planChanged = Boolean(
    normalizedPlan
    && normalizedCurrentPlan
    && normalizedPlan !== normalizedCurrentPlan
  );

  if (normalizedPlan === 'credits') {
    return 'credit_top_up';
  }

  if (eventType === 'checkout.session.completed') {
    if (paymentMode === 'payment') {
      if (hasExistingPaidPlan && planChanged) return 'upgrade';
      return 'new_purchase';
    }

    if (paymentMode === 'subscription') {
      if (hasExistingPaidPlan && planChanged) return 'upgrade';
      return 'new_purchase';
    }
  }

  if (eventType === 'invoice.payment_succeeded') {
    if (billingReason === 'subscription_cycle') return 'renewal';
    if (billingReason === 'subscription_update' && hasExistingPaidPlan && planChanged) return 'upgrade';
    if (billingReason === 'subscription_create') {
      if (hasExistingPaidPlan && planChanged) return 'upgrade';
      return 'new_purchase';
    }
    if (!stripeSubscriptionId && billingReason === 'manual') {
      return 'new_purchase';
    }
    if (stripeSubscriptionId) {
      if (hasExistingPaidPlan && planChanged) return 'upgrade';
      return 'new_purchase';
    }
  }

  return explicitPurchaseType || 'unknown';
}

function inferBillingPeriod({ paymentMode, recurringInterval, billingCycle, purchaseType, plan }) {
  if (
    paymentMode === 'payment'
    || purchaseType === 'credit_top_up'
    || normalizePlanValue(plan) === 'credits'
  ) {
    return 'one_time';
  }

  const intervalPeriod = resolveBillingPeriodFromInterval(recurringInterval);
  if (intervalPeriod) return intervalPeriod;

  if (billingCycle === 'monthly' || billingCycle === 'month') return 'monthly';
  if (billingCycle === 'yearly' || billingCycle === 'year') return 'yearly';
  return 'unknown';
}

function inferTrialConversion({ metadata, purchaseType }) {
  const explicit = extractMetadataBoolean(metadata, ['is_trial_conversion', 'isTrialConversion', 'trial_conversion', 'trialConversion']);
  if (explicit !== null) {
    return explicit;
  }

  if (purchaseType === 'credit_top_up' || purchaseType === 'renewal') {
    return false;
  }

  return null;
}

function resolveCommercialPlan({ metadata, context, accountPlan }) {
  return normalizePlanValue(
    extractMetadataValue(metadata, ['plan', 'plan_type', 'planType'])
    || context.plan
    || accountPlan
    || null
  );
}

function resolveCheckoutBillingInterval(selectedPlan, selectedPlanId) {
  if (selectedPlan?.interval === 'month') return 'month';
  if (selectedPlan?.interval === 'year') return 'year';
  if (selectedPlan?.interval === 'one-time') return 'one_time';
  if (selectedPlanId && selectedPlanId !== 'credits') return 'month';
  return undefined;
}

function resolveCurrentPlan({ metadata, accountPlan }) {
  return normalizePlanValue(
    extractMetadataValue(metadata, ['current_plan', 'currentPlan', 'current_plan_type', 'currentPlanType'])
    || accountPlan
    || null
  );
}

function getPriceContextFromLineItem(lineItem, priceIds) {
  const priceId = normalizeStripeId(lineItem?.price) || normalizeStripeId(lineItem?.price?.id);
  const rawProduct = lineItem?.price?.product;
  const productId = normalizeStripeId(rawProduct);
  const recurringInterval = lineItem?.price?.recurring?.interval || null;

  return {
    priceId,
    productId,
    recurringInterval,
    plan: resolvePlanFromPriceId(priceIds, priceId)
  };
}

function getPriceContextFromSubscription(subscription, priceIds) {
  const firstItem = Array.isArray(subscription?.items?.data)
    ? subscription.items.data[0]
    : null;
  return getPriceContextFromLineItem(firstItem, priceIds);
}

function mergeCommercialContext(...contexts) {
  return contexts.reduce((merged, context) => {
    if (!context) return merged;
    return {
      priceId: merged.priceId || context.priceId || null,
      productId: merged.productId || context.productId || null,
      recurringInterval: merged.recurringInterval || context.recurringInterval || null,
      plan: merged.plan || context.plan || null,
      source: context.source || merged.source || 'fallback'
    };
  }, {
    priceId: null,
    productId: null,
    recurringInterval: null,
    plan: null,
    source: 'fallback'
  });
}

function resolveDistinctIdFromStripeEvent({
  account,
  accountId,
  userId,
  licenseKey,
  site,
  siteId,
  siteHash,
  stripeCustomerId,
  stripeSubscriptionId,
  checkoutSessionId,
  invoiceId
}) {
  if (account?.id) {
    return { distinctId: account.id, distinctIdSource: 'account_id' };
  }
  if (accountId) {
    return { distinctId: accountId, distinctIdSource: 'account_id' };
  }
  if (userId) {
    return { distinctId: userId, distinctIdSource: 'user_id' };
  }
  if (licenseKey) {
    return { distinctId: licenseKey, distinctIdSource: 'license_key' };
  }
  if (site?.id || siteId) {
    return { distinctId: site?.id || siteId, distinctIdSource: 'site_id' };
  }
  if (siteHash) {
    return { distinctId: siteHash, distinctIdSource: 'site_hash' };
  }
  if (stripeCustomerId) {
    return { distinctId: stripeCustomerId, distinctIdSource: 'stripe_customer_id' };
  }
  if (stripeSubscriptionId) {
    return { distinctId: stripeSubscriptionId, distinctIdSource: 'stripe_subscription_id' };
  }
  if (checkoutSessionId) {
    return { distinctId: checkoutSessionId, distinctIdSource: 'checkout_session_id' };
  }
  if (invoiceId) {
    return { distinctId: invoiceId, distinctIdSource: 'invoice_id' };
  }
  return { distinctId: null, distinctIdSource: 'missing' };
}

function resolveIdentityPath({ resolutionSource, distinctIdSource }) {
  if (resolutionSource === 'account_id' || resolutionSource === 'user_id') return 'account';
  if (resolutionSource === 'license_key') return 'license';
  if (resolutionSource === 'site_id' || resolutionSource === 'site_hash') return 'site';
  if (resolutionSource === 'stripe_customer_id' || resolutionSource === 'stripe_subscription_id') return 'stripe';
  if (resolutionSource === 'email') return 'email';

  if (distinctIdSource === 'account_id' || distinctIdSource === 'user_id') return 'account';
  if (distinctIdSource === 'license_key') return 'license';
  if (distinctIdSource === 'site_id' || distinctIdSource === 'site_hash') return 'site';
  if (distinctIdSource === 'stripe_customer_id' || distinctIdSource === 'stripe_subscription_id') return 'stripe';
  if (distinctIdSource === 'email') return 'email';
  if (distinctIdSource === 'checkout_session_id') return 'session';
  if (distinctIdSource === 'invoice_id') return 'invoice';
  return 'missing';
}

async function findAccountById(supabase, accountId) {
  if (!supabase || !accountId) return null;

  const { data, error } = await supabase
    .from('licenses')
    .select(ACCOUNT_SELECT)
    .eq('id', accountId)
    .maybeSingle();

  if (error) {
    logger.warn('[billing] account lookup by id failed', {
      accountId,
      error: error.message
    });
    return null;
  }

  return data || null;
}

async function findAccountByEmail(supabase, email) {
  if (!supabase || !email) return null;

  // `licenses` is the canonical account table in this backend.
  const { data, error } = await supabase
    .from('licenses')
    .select(ACCOUNT_SELECT)
    .eq('email', email)
    .maybeSingle();

  if (error) {
    logger.warn('[billing] account lookup by email failed', {
      email,
      error: error.message
    });
    return null;
  }

  return data || null;
}

async function findAccountByLicenseKey(supabase, licenseKey) {
  if (!supabase || !licenseKey) return null;

  const { data, error } = await supabase
    .from('licenses')
    .select(ACCOUNT_SELECT)
    .eq('license_key', licenseKey)
    .maybeSingle();

  if (error) {
    logger.warn('[billing] account lookup by license key failed', {
      licenseKeyPrefix: maskSecret(licenseKey),
      error: error.message
    });
    return null;
  }

  return data || null;
}

async function findAccountByStripeCustomerId(supabase, stripeCustomerId) {
  if (!supabase || !stripeCustomerId) return null;

  const { data, error } = await supabase
    .from('licenses')
    .select(ACCOUNT_SELECT)
    .eq('stripe_customer_id', stripeCustomerId)
    .maybeSingle();

  if (error) {
    logger.warn('[billing] account lookup by stripe customer failed', {
      stripeCustomerId,
      error: error.message
    });
    return null;
  }

  return data || null;
}

async function findAccountByStripeSubscriptionId(supabase, stripeSubscriptionId) {
  if (!supabase || !stripeSubscriptionId) return null;

  const { data, error } = await supabase
    .from('licenses')
    .select(ACCOUNT_SELECT)
    .eq('stripe_subscription_id', stripeSubscriptionId)
    .maybeSingle();

  if (error) {
    logger.warn('[billing] account lookup by stripe subscription failed', {
      stripeSubscriptionId,
      error: error.message
    });
    return null;
  }

  return data || null;
}

async function findSiteByHash(supabase, siteHash) {
  if (!supabase || !siteHash) return null;

  const { data, error } = await supabase
    .from('sites')
    .select(SITE_SELECT)
    .eq('site_hash', siteHash)
    .maybeSingle();

  if (error) {
    logger.warn('[billing] site lookup by hash failed', {
      siteHash,
      error: error.message
    });
    return null;
  }

  return data || null;
}

async function findSiteById(supabase, siteId) {
  if (!supabase || !siteId) return null;

  const { data, error } = await supabase
    .from('sites')
    .select(SITE_SELECT)
    .eq('id', siteId)
    .maybeSingle();

  if (error) {
    logger.warn('[billing] site lookup by id failed', {
      siteId,
      error: error.message
    });
    return null;
  }

  return data || null;
}

async function findSitesByLicenseKey(supabase, licenseKey) {
  if (!supabase || !licenseKey) return [];

  const { data, error } = await supabase
    .from('sites')
    .select(SITE_SELECT)
    .eq('license_key', licenseKey);

  if (error) {
    logger.warn('[billing] site lookup by license key failed', {
      licenseKeyPrefix: maskSecret(licenseKey),
      error: error.message
    });
    return [];
  }

  return Array.isArray(data) ? data.filter((site) => site?.id) : [];
}

async function findSiteByStripeSubscriptionId(supabase, stripeSubscriptionId) {
  if (!supabase || !stripeSubscriptionId) return null;

  const { data, error } = await supabase
    .from('site_subscriptions')
    .select('site_id')
    .eq('stripe_subscription_id', stripeSubscriptionId)
    .maybeSingle();

  if (error && error.code !== '42P01') {
    logger.warn('[billing] site lookup by stripe subscription failed', {
      stripeSubscriptionId,
      error: error.message
    });
    return null;
  }

  if (data?.site_id) {
    return findSiteById(supabase, data.site_id);
  }

  return null;
}

async function findSiteByStripeCustomerId(supabase, stripeCustomerId) {
  if (!supabase || !stripeCustomerId) return null;

  const { data, error } = await supabase
    .from('site_subscriptions')
    .select('site_id')
    .eq('stripe_customer_id', stripeCustomerId)
    .order('updated_at', { ascending: false })
    .limit(1);

  if (error && error.code !== '42P01') {
    logger.warn('[billing] site lookup by stripe customer failed', {
      stripeCustomerId,
      error: error.message
    });
    return null;
  }

  const siteId = Array.isArray(data) && data.length ? data[0].site_id : null;
  if (siteId) {
    return findSiteById(supabase, siteId);
  }

  return null;
}

function buildBillingInfoFromLicense(license) {
  let nextBillingDate = null;
  if (license?.billing_anchor_date) {
    const anchor = new Date(license.billing_anchor_date);
    if (!Number.isNaN(anchor.getTime())) {
      const next = new Date(anchor);
      next.setUTCMonth(next.getUTCMonth() + 1);
      nextBillingDate = next.toISOString();
    }
  }

  return {
    plan: normalizePlanValue(license?.plan) || 'free',
    status: license?.status || 'active',
    billingCycle: license?.billing_cycle || 'monthly',
    nextBillingDate,
    subscriptionId: license?.stripe_subscription_id || null,
    cancelAtPeriodEnd: false,
    customerId: license?.stripe_customer_id || null
  };
}

function buildBillingInfoFromSiteSubscription(subscription, fallbackBilling) {
  return {
    plan: normalizePlanValue(subscription?.plan_id) || fallbackBilling.plan,
    status: subscription?.status || fallbackBilling.status,
    billingCycle: resolveBillingPeriodFromInterval(subscription?.billing_interval) || fallbackBilling.billingCycle,
    nextBillingDate: subscription?.current_period_end || fallbackBilling.nextBillingDate,
    subscriptionId: subscription?.stripe_subscription_id || fallbackBilling.subscriptionId,
    cancelAtPeriodEnd: Boolean(subscription?.cancel_at_period_end),
    customerId: subscription?.stripe_customer_id || fallbackBilling.customerId
  };
}

async function selectLatestSiteSubscription(query, context = {}) {
  if (!query) {
    return null;
  }

  const { data, error } = await query
    .in('status', ACTIVE_BILLING_STATUSES)
    .order('current_period_end', { ascending: false, nullsFirst: false })
    .limit(1);

  if (error) {
    logger.warn('[billing] site subscription lookup failed', {
      ...context,
      error: error.message
    });
    return null;
  }

  return Array.isArray(data) && data.length ? data[0] : null;
}

async function selectBillingSiteSubscriptionForLicense(supabase, license) {
  if (!supabase || !license) {
    return { subscription: null, resolutionPath: 'license' };
  }

  if (license.stripe_subscription_id) {
    const subscription = await selectLatestSiteSubscription(
      supabase
        .from('site_subscriptions')
        .select(SITE_SUBSCRIPTION_SELECT)
        .eq('stripe_subscription_id', license.stripe_subscription_id),
      {
        stripe_subscription_id: license.stripe_subscription_id,
        lookup: 'stripe_subscription_id'
      }
    );

    if (subscription) {
      return { subscription, resolutionPath: 'stripe_subscription_id' };
    }
  }

  if (license.stripe_customer_id) {
    const subscription = await selectLatestSiteSubscription(
      supabase
        .from('site_subscriptions')
        .select(SITE_SUBSCRIPTION_SELECT)
        .eq('stripe_customer_id', license.stripe_customer_id),
      {
        stripe_customer_id: license.stripe_customer_id,
        lookup: 'stripe_customer_id'
      }
    );

    if (subscription) {
      return { subscription, resolutionPath: 'stripe_customer_id' };
    }
  }

  if (license.license_key) {
    const { data: sites, error } = await supabase
      .from('sites')
      .select('id')
      .eq('license_key', license.license_key);

    if (error) {
      logger.warn('[billing] site lookup by license key failed', {
        licenseKeyPrefix: maskSecret(license.license_key),
        lookup: 'license_sites',
        error: error.message
      });
      return { subscription: null, resolutionPath: 'license' };
    }

    const siteIds = Array.isArray(sites)
      ? sites.map((site) => site?.id).filter(Boolean)
      : [];

    if (siteIds.length) {
      const subscription = await selectLatestSiteSubscription(
        supabase
          .from('site_subscriptions')
          .select(SITE_SUBSCRIPTION_SELECT)
          .in('site_id', siteIds),
        {
          licenseKeyPrefix: maskSecret(license.license_key),
          lookup: 'license_sites',
          site_ids: siteIds
        }
      );

      if (subscription) {
        return { subscription, resolutionPath: 'license_sites' };
      }
    }
  }

  return { subscription: null, resolutionPath: 'license' };
}

async function persistStripeMappings(supabase, account, { stripeCustomerId, stripeSubscriptionId }) {
  if (!supabase || !account?.id) {
    return account || null;
  }

  const payload = {};

  if (stripeCustomerId && !account.stripe_customer_id) {
    payload.stripe_customer_id = stripeCustomerId;
  } else if (
    stripeCustomerId
    && account.stripe_customer_id
    && account.stripe_customer_id !== stripeCustomerId
  ) {
    logger.warn('[billing] stripe customer mapping conflict', {
      accountId: account.id,
      existingStripeCustomerId: account.stripe_customer_id,
      incomingStripeCustomerId: stripeCustomerId
    });
  }

  if (stripeSubscriptionId && !account.stripe_subscription_id) {
    payload.stripe_subscription_id = stripeSubscriptionId;
  } else if (
    stripeSubscriptionId
    && account.stripe_subscription_id
    && account.stripe_subscription_id !== stripeSubscriptionId
  ) {
    logger.warn('[billing] stripe subscription mapping conflict', {
      accountId: account.id,
      existingStripeSubscriptionId: account.stripe_subscription_id,
      incomingStripeSubscriptionId: stripeSubscriptionId
    });
  }

  if (!Object.keys(payload).length) {
    return account;
  }

  const { data, error } = await supabase
    .from('licenses')
    .update(payload)
    .eq('id', account.id)
    .select(ACCOUNT_SELECT)
    .single();

  if (error) {
    logger.error('[billing] stripe_mapping_write', {
      table: 'licenses',
      success: false,
      account_id: account.id,
      stripe_customer_id: payload.stripe_customer_id || null,
      stripe_subscription_id: payload.stripe_subscription_id || null,
      error: error.message
    });
    logger.warn('[billing] failed to persist stripe mappings', {
      accountId: account.id,
      stripeCustomerId: payload.stripe_customer_id || null,
      stripeSubscriptionId: payload.stripe_subscription_id || null,
      error: error.message
    });
    return {
      ...account,
      ...payload
    };
  }

  logger.info('[billing] stripe_mapping_write', {
    table: 'licenses',
    success: true,
    account_id: account.id,
    stripe_customer_id: payload.stripe_customer_id || null,
    stripe_subscription_id: payload.stripe_subscription_id || null
  });
  logger.info('[billing] persisted stripe mappings', {
    accountId: account.id,
    stripeCustomerId: payload.stripe_customer_id || null,
    stripeSubscriptionId: payload.stripe_subscription_id || null
  });

  return data || {
    ...account,
    ...payload
  };
}

async function resolveIdentityContext({
  supabase,
  metadata,
  email,
  stripeCustomerId,
  stripeSubscriptionId
}) {
  const accountId = extractMetadataValue(metadata, ['account_id', 'accountId']);
  const userId = extractMetadataValue(metadata, ['user_id', 'userId']);
  const licenseKey = extractMetadataValue(metadata, ['license_key', 'licenseKey']);
  const siteId = extractMetadataValue(metadata, ['site_id', 'siteId']);
  const siteHash = extractMetadataValue(metadata, ['site_hash', 'siteHash']);
  const siteUrl = extractMetadataValue(metadata, ['site_url', 'siteUrl']);
  const siteFingerprint = extractMetadataValue(metadata, ['site_fingerprint', 'siteFingerprint', 'fingerprint']);

  let account = null;
  let site = null;
  let resolutionSource = 'unresolved';

  if (accountId) {
    account = await findAccountById(supabase, accountId);
    if (account) {
      resolutionSource = 'account_id';
    } else {
      logger.warn('[billing] account not found for metadata account id', { accountId });
    }
  }

  if (!account && userId) {
    account = await findAccountById(supabase, userId);
    if (account) {
      resolutionSource = 'user_id';
    } else {
      logger.warn('[billing] account not found for metadata user id', { userId });
    }
  }

  if (!account && licenseKey) {
    account = await findAccountByLicenseKey(supabase, licenseKey);
    if (account) {
      resolutionSource = 'license_key';
    } else {
      logger.warn('[billing] account not found for metadata license key', {
        licenseKeyPrefix: maskSecret(licenseKey)
      });
    }
  }

  if (!site && siteId) {
    site = await findSiteById(supabase, siteId);
    if (site) {
      resolutionSource = resolutionSource === 'unresolved' ? 'site_id' : resolutionSource;
    } else {
      logger.warn('[billing] site not found for metadata site id', { siteId });
    }
  }

  if (!site && siteHash) {
    site = await findSiteByHash(supabase, siteHash);
    if (site) {
      resolutionSource = resolutionSource === 'unresolved' ? 'site_hash' : resolutionSource;
    } else {
      logger.warn('[billing] site not found for metadata site hash', { siteHash });
    }
  }

  if (!account && site?.license_key) {
    account = await findAccountByLicenseKey(supabase, site.license_key);
    if (account) {
      resolutionSource = 'site_hash';
    }
  }

  if (!site && stripeSubscriptionId) {
    site = await findSiteByStripeSubscriptionId(supabase, stripeSubscriptionId);
    if (site) {
      resolutionSource = resolutionSource === 'unresolved' ? 'stripe_subscription_id' : resolutionSource;
    }
  }

  if (!site && stripeCustomerId) {
    site = await findSiteByStripeCustomerId(supabase, stripeCustomerId);
    if (site) {
      resolutionSource = resolutionSource === 'unresolved' ? 'stripe_customer_id' : resolutionSource;
    }
  }

  if (!account && site?.license_key) {
    account = await findAccountByLicenseKey(supabase, site.license_key);
    if (account) {
      resolutionSource = resolutionSource === 'unresolved' ? 'site_hash' : resolutionSource;
    }
  }

  if (!account && stripeSubscriptionId) {
    account = await findAccountByStripeSubscriptionId(supabase, stripeSubscriptionId);
    if (account) {
      resolutionSource = 'stripe_subscription_id';
    }
  }

  if (!account && stripeCustomerId) {
    account = await findAccountByStripeCustomerId(supabase, stripeCustomerId);
    if (account) {
      resolutionSource = 'stripe_customer_id';
    }
  }

  if (!account && email) {
    account = await findAccountByEmail(supabase, email);
    if (account) {
      resolutionSource = 'email';
    }
  }

  if (!site && siteHash) {
    const resolved = await resolveCanonicalSite(supabase, buildSiteIdentity({
      siteHash,
      installUuid: siteHash,
      siteUrl,
      siteFingerprint,
      allowDevelopment: true
    }), {
      createIfMissing: true,
      legacyLicenseKey: licenseKey || account?.license_key || null,
      account
    });

    if (resolved?.site) {
      site = resolved.site;
      resolutionSource = resolutionSource === 'unresolved' ? 'site_hash' : resolutionSource;
      logger.info('[billing] canonical billing site resolved', {
        site_id: site.id,
        site_hash: site.site_hash || siteHash || null,
        matched_by: resolved.matchedBy || null,
        created: Boolean(resolved.created),
        licenseKeyPrefix: maskSecret(licenseKey || account?.license_key || null)
      });
    } else if (resolved?.error) {
      logger.error('[billing] canonical billing site resolution failed', {
        site_hash: siteHash,
        site_url: siteUrl || null,
        licenseKeyPrefix: maskSecret(licenseKey || account?.license_key || null),
        error: resolved.error,
        site_write_error: resolved.diagnostics?.site_write_error || null
      });
    }
  }

  if (!site) {
    const siteLicenseKey = licenseKey || account?.license_key || null;
    const licenseSites = await findSitesByLicenseKey(supabase, siteLicenseKey);
    if (licenseSites.length === 1) {
      site = licenseSites[0];
      resolutionSource = resolutionSource === 'unresolved' ? 'license_sites' : resolutionSource;
      logger.info('[billing] canonical billing site resolved from license', {
        site_id: site.id,
        site_hash: site.site_hash || null,
        licenseKeyPrefix: maskSecret(siteLicenseKey)
      });
    } else if (licenseSites.length > 1) {
      logger.warn('[billing] billing site resolution ambiguous for license', {
        licenseKeyPrefix: maskSecret(siteLicenseKey),
        candidate_site_ids: licenseSites.map((candidate) => candidate.id)
      });
    }
  }

  if (!account && site?.license_key) {
    account = await findAccountByLicenseKey(supabase, site.license_key);
    if (account && resolutionSource === 'unresolved') {
      resolutionSource = 'site_hash';
    }
  }

  if (account) {
    account = await persistStripeMappings(supabase, account, {
      stripeCustomerId,
      stripeSubscriptionId
    });
  } else if (licenseKey || siteHash || email || stripeCustomerId || stripeSubscriptionId) {
    logger.warn('[billing] account not resolved for payment event', {
      licenseKeyPrefix: maskSecret(licenseKey),
      siteHash,
      email: email || null,
      stripeCustomerId: stripeCustomerId || null,
      stripeSubscriptionId: stripeSubscriptionId || null
    });
  }

  return {
    account,
    site,
    accountId: account?.id || accountId || null,
    userId: userId || account?.id || accountId || null,
    email: account?.email || email || null,
    licenseKey: licenseKey || account?.license_key || site?.license_key || null,
    siteId: site?.id || siteId || null,
    siteHash: site?.site_hash || siteHash || null,
    resolutionSource
  };
}

async function loadCheckoutLineItemContext(stripeClient, session, priceIds) {
  const metadata = session?.metadata || {};
  const metadataContext = {
    priceId: extractMetadataValue(metadata, ['price_id', 'priceId']),
    productId: extractMetadataValue(metadata, ['product_id', 'productId']),
    recurringInterval: extractMetadataValue(metadata, ['billing_interval', 'billingInterval']),
    plan: extractMetadataValue(metadata, ['plan', 'plan_type', 'planType']),
    source: 'metadata'
  };

  const embeddedItems = Array.isArray(session?.line_items?.data) ? session.line_items.data : null;
  if (embeddedItems?.length) {
    const embeddedContext = getPriceContextFromLineItem(embeddedItems[0], priceIds);
    return mergeCommercialContext(embeddedContext, metadataContext, { source: 'session.line_items' });
  }

  if (!stripeClient || !session?.id) {
    return mergeCommercialContext(metadataContext);
  }

  if (!isStripeModeCompatible(Boolean(session.livemode))) {
    logger.warn('[billing] webhook line item lookup skipped: stripe mode mismatch', {
      sessionId: session.id,
      eventLivemode: Boolean(session.livemode),
      stripeKeyMode: resolveStripeSecretMode()
    });
    return mergeCommercialContext(metadataContext, { source: 'mode_mismatch' });
  }

  try {
    const lineItems = await stripeClient.checkout.sessions.listLineItems(session.id, { limit: 1 });
    const firstLineItem = Array.isArray(lineItems?.data) ? lineItems.data[0] : null;
    const resolvedContext = getPriceContextFromLineItem(firstLineItem, priceIds);
    return mergeCommercialContext(resolvedContext, metadataContext, { source: 'stripe.list_line_items' });
  } catch (error) {
    logger.warn('[billing] webhook line item lookup failed', {
      sessionId: session.id,
      error: error.message
    });
    return mergeCommercialContext(metadataContext, { source: 'lookup_failed' });
  }
}

async function loadInvoiceLineContext(stripeClient, invoice, priceIds, metadataOverride) {
  const metadata = metadataOverride || invoice?.metadata || {};
  const metadataContext = {
    priceId: extractMetadataValue(metadata, ['price_id', 'priceId']),
    productId: extractMetadataValue(metadata, ['product_id', 'productId']),
    recurringInterval: extractMetadataValue(metadata, ['billing_interval', 'billingInterval']),
    plan: extractMetadataValue(metadata, ['plan', 'plan_type', 'planType']),
    source: 'metadata'
  };

  const embeddedItems = Array.isArray(invoice?.lines?.data) ? invoice.lines.data : null;
  if (embeddedItems?.length) {
    const embeddedContext = getPriceContextFromLineItem(embeddedItems[0], priceIds);
    return mergeCommercialContext(embeddedContext, metadataContext, { source: 'invoice.lines' });
  }

  if (!stripeClient || !invoice?.id) {
    return mergeCommercialContext(metadataContext);
  }

  if (!isStripeModeCompatible(Boolean(invoice.livemode))) {
    logger.warn('[billing] webhook invoice enrichment skipped: stripe mode mismatch', {
      invoiceId: invoice.id,
      eventLivemode: Boolean(invoice.livemode),
      stripeKeyMode: resolveStripeSecretMode()
    });
    return mergeCommercialContext(metadataContext, { source: 'mode_mismatch' });
  }

  try {
    const expandedInvoice = await stripeClient.invoices.retrieve(invoice.id, {
      expand: ['lines.data.price.product']
    });
    const firstLineItem = Array.isArray(expandedInvoice?.lines?.data) ? expandedInvoice.lines.data[0] : null;
    const resolvedContext = getPriceContextFromLineItem(firstLineItem, priceIds);
    return mergeCommercialContext(resolvedContext, metadataContext, { source: 'stripe.retrieve_invoice' });
  } catch (error) {
    logger.warn('[billing] webhook invoice enrichment lookup failed', {
      invoiceId: invoice.id,
      error: error.message
    });
    return mergeCommercialContext(metadataContext, { source: 'lookup_failed' });
  }
}

async function loadSubscriptionMetadata(stripeClient, stripeSubscriptionId, livemode) {
  if (!stripeClient?.subscriptions?.retrieve || !stripeSubscriptionId) {
    return {};
  }

  if (!isStripeModeCompatible(Boolean(livemode))) {
    logger.warn('[billing] subscription metadata lookup skipped: stripe mode mismatch', {
      stripeSubscriptionId,
      eventLivemode: Boolean(livemode),
      stripeKeyMode: resolveStripeSecretMode()
    });
    return {};
  }

  try {
    const subscription = await stripeClient.subscriptions.retrieve(stripeSubscriptionId);
    return mergeStripeMetadata(subscription?.metadata);
  } catch (error) {
    logger.warn('[billing] subscription metadata lookup failed', {
      stripeSubscriptionId,
      error: error.message
    });
    return {};
  }
}

async function loadCustomerMetadata(stripeClient, stripeCustomerId, livemode) {
  if (!stripeClient?.customers?.retrieve || !stripeCustomerId) {
    return {};
  }

  if (!isStripeModeCompatible(Boolean(livemode))) {
    logger.warn('[billing] customer metadata lookup skipped: stripe mode mismatch', {
      stripeCustomerId,
      eventLivemode: Boolean(livemode),
      stripeKeyMode: resolveStripeSecretMode()
    });
    return {};
  }

  try {
    const customer = await stripeClient.customers.retrieve(stripeCustomerId);
    if (!customer || customer.deleted) {
      return {};
    }

    return mergeStripeMetadata(customer.metadata);
  } catch (error) {
    logger.warn('[billing] customer metadata lookup failed', {
      stripeCustomerId,
      error: error.message
    });
    return {};
  }
}

async function resolveInvoiceMetadata(stripeClient, invoice) {
  const stripeSubscriptionId = normalizeStripeId(invoice?.subscription);
  const stripeCustomerId = normalizeStripeId(invoice?.customer);
  const invoiceMetadata = mergeStripeMetadata(
    invoice?.metadata,
    invoice?.parent?.subscription_details?.metadata,
    invoice?.subscription_details?.metadata
  );
  const subscriptionMetadata = await loadSubscriptionMetadata(
    stripeClient,
    stripeSubscriptionId,
    invoice?.livemode
  );
  const customerMetadata = await loadCustomerMetadata(
    stripeClient,
    stripeCustomerId,
    invoice?.livemode
  );

  return mergeStripeMetadata(
    invoiceMetadata,
    subscriptionMetadata,
    customerMetadata
  );
}

async function buildCheckoutSucceededPayload({ supabase, stripeClient, session, priceIds }) {
  const metadata = session.metadata || {};
  const context = await loadCheckoutLineItemContext(stripeClient, session, priceIds);
  const stripeCustomerId = normalizeStripeId(session.customer);
  const stripeSubscriptionId = normalizeStripeId(session.subscription);
  const identity = await resolveIdentityContext({
    supabase,
    metadata,
    email: session.customer_details?.email || session.customer_email || extractMetadataValue(metadata, ['email']),
    stripeCustomerId,
    stripeSubscriptionId
  });
  const licenseKey = identity.licenseKey;
  const plan = resolveCommercialPlan({
    metadata,
    context,
    accountPlan: identity.account?.plan || null
  });
  const currentPlan = resolveCurrentPlan({
    metadata,
    accountPlan: identity.account?.plan || null
  });
  const purchaseType = inferPurchaseType({
    eventType: 'checkout.session.completed',
    paymentMode: session.mode,
    stripeSubscriptionId,
    billingReason: null,
    plan,
    currentPlan,
    metadataPurchaseType: extractMetadataValue(metadata, ['purchase_type', 'purchaseType'])
  });
  const billingPeriod = inferBillingPeriod({
    paymentMode: session.mode,
    recurringInterval: context.recurringInterval,
    billingCycle: identity.account?.billing_cycle || null,
    purchaseType,
    plan
  });
  const currency = normalizeCurrency(session.currency);
  const amount = resolveAmount(session.amount_total, currency);
  const { distinctId, distinctIdSource } = resolveDistinctIdFromStripeEvent({
    account: identity.account,
    accountId: identity.accountId,
    userId: identity.userId,
    licenseKey,
    site: identity.site,
    siteId: identity.siteId,
    siteHash: identity.siteHash,
    stripeCustomerId,
    stripeSubscriptionId,
    email: identity.email,
    checkoutSessionId: session.id,
    invoiceId: normalizeStripeId(session.invoice)
  });
  const identityPath = resolveIdentityPath({
    resolutionSource: identity.resolutionSource,
    distinctIdSource
  });
  const attribution = resolveAttributionProperties(metadata);

  logger.info('[billing] webhook enrichment resolved', {
    stripeEventType: 'checkout.session.completed',
    sessionId: session.id,
    source: context.source,
    plan,
    priceId: context.priceId,
    productId: context.productId
  });

  return {
    distinctId,
    distinctIdSource,
    account: identity.account,
    site: identity.site,
    eventProperties: {
      source: 'stripe_webhook',
      stripe_event_type: 'checkout.session.completed',
      amount,
      amount_minor: session.amount_total ?? null,
      revenue: amount,
      currency,
      plan,
      price_id: context.priceId,
      product_id: context.productId,
      stripe_customer_id: stripeCustomerId,
      stripe_subscription_id: stripeSubscriptionId,
      checkout_session_id: session.id,
      invoice_id: normalizeStripeId(session.invoice),
      payment_link_id: normalizeStripeId(session.payment_link),
      site_id: identity.siteId,
      site_hash: identity.siteHash,
      email: identity.email,
      account_id: identity.account?.id || identity.accountId || null,
      user_id: identity.userId || identity.account?.id || null,
      license_key: licenseKey,
      license_key_present: Boolean(licenseKey),
      trigger_feature: attribution.trigger_feature || null,
      trigger_location: attribution.trigger_location || null,
      source_page: attribution.source_page || null,
      target_plan: attribution.target_plan || null,
      identity_path: identityPath,
      livemode: Boolean(session.livemode),
      payment_mode: session.mode || null,
      billing_reason: null,
      billing_period: billingPeriod,
      purchase_type: purchaseType,
      is_trial_conversion: inferTrialConversion({ metadata, purchaseType })
    }
  };
}

async function buildInvoiceSucceededPayload({ supabase, stripeClient, invoice, priceIds }) {
  const metadata = await resolveInvoiceMetadata(stripeClient, invoice);
  const stripeCustomerId = normalizeStripeId(invoice.customer);
  const stripeSubscriptionId = normalizeStripeId(invoice.subscription);
  const identity = await resolveIdentityContext({
    supabase,
    metadata,
    email: invoice.customer_email || extractMetadataValue(metadata, ['email']),
    stripeCustomerId,
    stripeSubscriptionId
  });
  const context = await loadInvoiceLineContext(stripeClient, invoice, priceIds, metadata);
  const licenseKey = identity.licenseKey;
  const plan = resolveCommercialPlan({
    metadata,
    context,
    accountPlan: identity.account?.plan || null
  });
  const currentPlan = resolveCurrentPlan({
    metadata,
    accountPlan: identity.account?.plan || null
  });
  const currency = normalizeCurrency(invoice.currency);
  const amount = resolveAmount(invoice.amount_paid, currency);
  const purchaseType = inferPurchaseType({
    eventType: 'invoice.payment_succeeded',
    paymentMode: null,
    stripeSubscriptionId,
    billingReason: invoice.billing_reason || null,
    plan,
    currentPlan,
    metadataPurchaseType: extractMetadataValue(metadata, ['purchase_type', 'purchaseType'])
  });
  const billingPeriod = inferBillingPeriod({
    paymentMode: null,
    recurringInterval: context.recurringInterval,
    billingCycle: identity.account?.billing_cycle || null,
    purchaseType,
    plan
  });
  const { distinctId, distinctIdSource } = resolveDistinctIdFromStripeEvent({
    account: identity.account,
    accountId: identity.accountId,
    userId: identity.userId,
    licenseKey,
    site: identity.site,
    siteId: identity.siteId,
    siteHash: identity.siteHash,
    stripeCustomerId,
    stripeSubscriptionId,
    email: identity.email,
    checkoutSessionId: null,
    invoiceId: invoice.id
  });
  const identityPath = resolveIdentityPath({
    resolutionSource: identity.resolutionSource,
    distinctIdSource
  });
  const attribution = resolveAttributionProperties(metadata);

  logger.info('[billing] webhook enrichment resolved', {
    stripeEventType: 'invoice.payment_succeeded',
    invoiceId: invoice.id,
    source: context.source,
    plan,
    priceId: context.priceId,
    productId: context.productId
  });

  return {
    distinctId,
    distinctIdSource,
    account: identity.account,
    site: identity.site,
    eventProperties: {
      source: 'stripe_webhook',
      stripe_event_type: 'invoice.payment_succeeded',
      amount,
      amount_minor: invoice.amount_paid ?? null,
      revenue: amount,
      currency,
      plan,
      price_id: context.priceId,
      product_id: context.productId,
      stripe_customer_id: stripeCustomerId,
      stripe_subscription_id: stripeSubscriptionId,
      checkout_session_id: null,
      invoice_id: invoice.id,
      payment_link_id: null,
      site_id: identity.siteId,
      site_hash: identity.siteHash,
      email: identity.email,
      account_id: identity.account?.id || identity.accountId || null,
      user_id: identity.userId || identity.account?.id || null,
      license_key: licenseKey,
      license_key_present: Boolean(licenseKey),
      trigger_feature: attribution.trigger_feature || null,
      trigger_location: attribution.trigger_location || null,
      source_page: attribution.source_page || null,
      target_plan: attribution.target_plan || null,
      identity_path: identityPath,
      livemode: Boolean(invoice.livemode),
      payment_mode: null,
      billing_reason: invoice.billing_reason || null,
      billing_period: billingPeriod,
      purchase_type: purchaseType,
      is_trial_conversion: inferTrialConversion({ metadata, purchaseType })
    }
  };
}

async function buildSubscriptionStatusPayload({ supabase, subscription, priceIds, stripeEventType }) {
  const metadata = mergeStripeMetadata(subscription?.metadata);
  const stripeCustomerId = normalizeStripeId(subscription?.customer);
  const stripeSubscriptionId = normalizeStripeId(subscription);
  const customerEmail = typeof subscription?.customer === 'object' && !subscription.customer.deleted
    ? subscription.customer.email
    : null;
  const identity = await resolveIdentityContext({
    supabase,
    metadata,
    email: customerEmail || extractMetadataValue(metadata, ['email']),
    stripeCustomerId,
    stripeSubscriptionId
  });
  const context = getPriceContextFromSubscription(subscription, priceIds);
  const plan = resolveCommercialPlan({
    metadata,
    context,
    accountPlan: identity.account?.plan || null
  });
  const billingPeriod = inferBillingPeriod({
    paymentMode: null,
    recurringInterval: context.recurringInterval,
    billingCycle: identity.account?.billing_cycle || null,
    purchaseType: 'renewal',
    plan
  });

  logger.info('[billing] subscription webhook enrichment resolved', {
    stripeEventType,
    stripeSubscriptionId,
    status: subscription?.status || null,
    source: context.source,
    plan,
    priceId: context.priceId,
    productId: context.productId
  });

  return {
    account: identity.account,
    site: identity.site,
    eventProperties: {
      source: 'stripe_webhook',
      stripe_event_type: stripeEventType,
      plan,
      price_id: context.priceId,
      product_id: context.productId,
      stripe_customer_id: stripeCustomerId,
      stripe_subscription_id: stripeSubscriptionId,
      site_id: identity.siteId,
      site_hash: identity.siteHash,
      email: identity.email,
      account_id: identity.account?.id || identity.accountId || null,
      user_id: identity.userId || identity.account?.id || null,
      license_key: identity.licenseKey,
      license_key_present: Boolean(identity.licenseKey),
      livemode: Boolean(subscription?.livemode),
      billing_period: billingPeriod,
      purchase_type: 'renewal',
      subscription_status: subscription?.status || null,
      cancel_at_period_end: Boolean(subscription?.cancel_at_period_end)
    },
    subscription: {
      status: subscription?.status || null,
      cancel_at_period_end: Boolean(subscription?.cancel_at_period_end),
      current_period_start: subscription?.current_period_start
        ? new Date(subscription.current_period_start * 1000).toISOString()
        : null,
      current_period_end: subscription?.current_period_end
        ? new Date(subscription.current_period_end * 1000).toISOString()
        : null,
      canceled_at: subscription?.canceled_at
        ? new Date(subscription.canceled_at * 1000).toISOString()
        : null
    }
  };
}

async function syncCanceledSubscriptionPointers(supabase, { account, site, stripeSubscriptionId }) {
  const updates = {};

  if (account?.id && account.stripe_subscription_id === stripeSubscriptionId) {
    const { error } = await supabase
      .from('licenses')
      .update({
        plan: 'free',
        billing_cycle: 'monthly',
        stripe_subscription_id: null
      })
      .eq('id', account.id)
      .select(ACCOUNT_SELECT)
      .single();

    updates.license = {
      attempted: true,
      success: !error,
      error: error?.message || null
    };
  }

  if (site?.id) {
    const { error } = await supabase
      .from('sites')
      .update({
        quota_limit: 50,
        status: 'active'
      })
      .eq('id', site.id);

    updates.site = {
      attempted: true,
      success: !error,
      error: error?.message || null
    };
  }

  return updates;
}

async function updateSiteSubscriptionStatus(supabase, stripeSubscriptionId, eventProperties, subscription) {
  const status = subscription?.status || 'active';
  const inactive = INACTIVE_BILLING_STATUSES.includes(status);
  const updatePayload = {
    status,
    cancel_at_period_end: Boolean(subscription?.cancel_at_period_end),
    current_period_start: subscription?.current_period_start || null,
    current_period_end: subscription?.current_period_end || null
  };

  if (eventProperties?.plan) {
    updatePayload.plan_id = eventProperties.plan;
  }
  if (eventProperties?.stripe_customer_id) {
    updatePayload.stripe_customer_id = eventProperties.stripe_customer_id;
  }
  if (subscription?.canceled_at || inactive) {
    updatePayload.canceled_at = subscription?.canceled_at || new Date().toISOString();
  }

  const { data, error } = await supabase
    .from('site_subscriptions')
    .update(updatePayload)
    .eq('stripe_subscription_id', stripeSubscriptionId)
    .select(SITE_SUBSCRIPTION_SELECT)
    .maybeSingle();

  if (error) {
    throw new Error(`site subscription status update failed: ${error.message}`);
  }

  return data || null;
}

async function reconcileSubscriptionStatus({
  supabase,
  stripeEventId,
  account,
  site,
  eventProperties,
  subscription
}) {
  const stripeSubscriptionId = eventProperties?.stripe_subscription_id || null;
  const status = subscription?.status || 'active';
  const active = ACTIVE_BILLING_STATUSES.includes(status);
  const inactive = INACTIVE_BILLING_STATUSES.includes(status);
  const trace = {
    stripe_event_id: stripeEventId,
    stripe_event_type: eventProperties?.stripe_event_type || null,
    account_id: account?.id || null,
    site_id: site?.id || null,
    site_hash: site?.site_hash || eventProperties?.site_hash || null,
    plan: eventProperties?.plan || null,
    subscription_status: status,
    subscriptions_written: false,
    licenses_updated: false,
    billing_info_source: 'site_subscriptions'
  };

  if (!supabase || !stripeSubscriptionId) {
    trace.billing_info_source = 'unresolved';
    return trace;
  }

  if (active && site?.id && eventProperties?.plan) {
    const entitlementTrace = await reconcileSiteEntitlement({
      supabase,
      stripeEventId,
      account,
      site,
      eventProperties,
      subscriptionStatus: status,
      currentPeriodStart: subscription.current_period_start,
      currentPeriodEnd: subscription.current_period_end
    });
    const siteSubscription = await updateSiteSubscriptionStatus(
      supabase,
      stripeSubscriptionId,
      eventProperties,
      subscription
    );
    return {
      ...trace,
      ...entitlementTrace,
      subscriptions_written: Boolean(entitlementTrace.subscriptions_written || siteSubscription),
      subscription_status: status
    };
  }

  let data = null;
  try {
    data = await updateSiteSubscriptionStatus(supabase, stripeSubscriptionId, eventProperties, subscription);
  } catch (error) {
    trace.billing_info_source = 'site_subscriptions_failed';
    trace.site_subscription_update_error = error.message;
    throw error;
  }

  trace.subscriptions_written = Boolean(data);

  if (inactive) {
    const pointerUpdates = await syncCanceledSubscriptionPointers(supabase, {
      account,
      site,
      stripeSubscriptionId
    });
    trace.licenses_updated = Boolean(pointerUpdates.license?.success);
    trace.canceled_pointer_updates = pointerUpdates;
  }

  return trace;
}

async function emitIdentity({ account, stripeCustomerId }) {
  if (!account?.id) {
    return;
  }

  const result = await identifyServerUser({
    distinctId: account.id,
    properties: {
      email: account.email || null,
      stripe_customer_id: stripeCustomerId || account.stripe_customer_id || null,
      stripe_subscription_id: account.stripe_subscription_id || null,
      license_key: account.license_key || null,
      plan: account.plan || null
    }
  });

  if (result.ok) {
    logger.info('[billing] PostHog identify succeeded', {
      accountId: account.id,
      stripeCustomerId: stripeCustomerId || account.stripe_customer_id || null,
      status: result.status || null
    });
    return;
  }

  if (!result.skipped) {
    logger.warn('[billing] PostHog identify failed', {
      accountId: account.id,
      stripeCustomerId: stripeCustomerId || account.stripe_customer_id || null,
      status: result.status || null,
      error: result.error?.message || null
    });
  }
}

function normalizeBillingInterval(billingPeriod) {
  if (billingPeriod === 'monthly') return 'month';
  if (billingPeriod === 'yearly') return 'year';
  if (billingPeriod === 'one_time') return 'one_time';
  return null;
}

async function reconcileSiteEntitlement({
  supabase,
  stripeEventId,
  account,
  site,
  eventProperties,
  subscriptionStatus = 'active',
  currentPeriodStart = null,
  currentPeriodEnd = null
}) {
  const trace = {
    stripe_event_id: stripeEventId,
    stripe_event_type: eventProperties?.stripe_event_type || null,
    site_id: site?.id || null,
    site_hash: site?.site_hash || eventProperties?.site_hash || null,
    plan: eventProperties?.plan || null,
    purchase_type: eventProperties?.purchase_type || null,
    licenses_updated: false,
    subscriptions_written: false,
    site_subscription_rpc_executed: false,
    site_subscription_rpc_skipped: false,
    site_subscription_rpc_error: null,
    billing_info_source: 'licenses'
  };

  if (!site?.id || !eventProperties?.plan) {
    trace.billing_info_source = site?.id ? 'licenses' : 'legacy_license_only';
    return trace;
  }

  const reconciliation = await reconcileBillingEntitlement(supabase, {
    siteId: site.id,
    stripeEventId,
    planId: eventProperties.plan,
    purchaseType: eventProperties.purchase_type,
    billingInterval: normalizeBillingInterval(eventProperties.billing_period),
    stripeCustomerId: eventProperties.stripe_customer_id,
    stripeSubscriptionId: eventProperties.stripe_subscription_id,
    subscriptionStatus,
    currentPeriodStart,
    currentPeriodEnd,
    metadata: {
      stripe_event_type: eventProperties.stripe_event_type,
      site_hash: eventProperties.site_hash || null,
      license_key: eventProperties.license_key || null,
      account_id: eventProperties.account_id || null
    }
  });
  trace.site_subscription_rpc_executed = Boolean(!reconciliation?.skipped);
  trace.site_subscription_rpc_skipped = Boolean(reconciliation?.skipped);
  trace.site_subscription_rpc_error = reconciliation?.error
    ? reconciliation.error.message
    : null;
  trace.subscriptions_written = Boolean(reconciliation?.data?.site_subscription_id);
  trace.billing_info_source = reconciliation?.skipped
    ? 'licenses'
    : 'site_subscriptions';

  if (reconciliation?.skipped) {
    logger.warn('[billing] site entitlement V2 skipped; using legacy billing fallback', {
      stripeEventId,
      siteId: site.id,
      plan: eventProperties.plan,
      purchaseType: eventProperties.purchase_type
    });
    return trace;
  }

  if (reconciliation?.error) {
    trace.billing_info_source = 'licenses';
    logger.warn('[billing] site entitlement V2 failed; using legacy billing fallback', {
      stripeEventId,
      siteId: site.id,
      plan: eventProperties.plan,
      purchaseType: eventProperties.purchase_type,
      error: reconciliation.error.message
    });
    return trace;
  }

  const pointerDiagnostics = {};
  await syncLegacySitePointers(supabase, {
    site,
    account,
    subscription: {
      stripe_customer_id: eventProperties.stripe_customer_id,
      stripe_subscription_id: eventProperties.stripe_subscription_id,
      billing_interval: normalizeBillingInterval(eventProperties.billing_period),
      status: subscriptionStatus
    },
    planId: eventProperties.plan,
    diagnostics: pointerDiagnostics
  });
  trace.licenses_updated = Boolean(pointerDiagnostics.legacy_license_pointer_sync?.success);
  trace.legacy_license_pointer_sync = pointerDiagnostics.legacy_license_pointer_sync || null;
  trace.legacy_site_pointer_sync = pointerDiagnostics.legacy_site_pointer_sync || null;

  logger.info('[billing] site entitlement reconciled', {
    stripeEventId,
    siteId: site.id,
    plan: eventProperties.plan,
    purchaseType: eventProperties.purchase_type,
    siteSubscriptionId: reconciliation?.data?.site_subscription_id || null
  });

  return trace;
}

async function emitPaymentSucceeded({
  stripeEventId,
  distinctId,
  distinctIdSource,
  account,
  eventProperties
}) {
  if (!distinctId) {
    logger.warn('[billing] webhook payment_succeeded skipped: no distinct id', {
      stripeEventId,
      stripeEventType: eventProperties.stripe_event_type
    });
    return;
  }

  logger.info('[billing] webhook identity resolved', {
    stripeEventId,
    stripeEventType: eventProperties.stripe_event_type,
    distinctId,
    distinctIdSource,
    identityPath: eventProperties.identity_path || resolveIdentityPath({ resolutionSource: null, distinctIdSource }),
    accountId: account?.id || null,
    licenseKeyPrefix: maskSecret(eventProperties.license_key || null),
    siteId: eventProperties.site_id || null,
    siteHash: eventProperties.site_hash || null,
    stripeCustomerId: eventProperties.stripe_customer_id || null,
    stripeSubscriptionId: eventProperties.stripe_subscription_id || null
  });

  logger.info('[billing] identity path', {
    stripeEventId,
    stripeEventType: eventProperties.stripe_event_type,
    path: eventProperties.identity_path || resolveIdentityPath({ resolutionSource: null, distinctIdSource })
  });

  logger.info('[billing] PostHog capture attempt', {
    stripeEventId,
    stripeEventType: eventProperties.stripe_event_type,
    distinctId
  });

  const result = await captureServerEvent({
    event: 'payment_succeeded',
    distinctId,
    properties: {
      ...eventProperties,
      stripe_event_id: stripeEventId,
      $insert_id: stripeEventId
    }
  });

  if (result.ok) {
    logger.info('[billing] PostHog capture succeeded', {
      stripeEventId,
      stripeEventType: eventProperties.stripe_event_type,
      status: result.status || null
    });
  } else if (!result.skipped) {
    logger.warn('[billing] PostHog capture failed', {
      stripeEventId,
      stripeEventType: eventProperties.stripe_event_type,
      status: result.status || null,
      error: result.error?.message || null
    });
  }

  await emitIdentity({
    account,
    stripeCustomerId: eventProperties.stripe_customer_id
  });
}

async function emitLoopsPurchaseSucceeded({ stripeEventId, eventProperties }) {
  const purchaseType = eventProperties?.purchase_type || 'unknown';
  const shouldNotify = ['new_purchase', 'upgrade'].includes(purchaseType);
  const email = eventProperties?.email || null;
  const plan = eventProperties?.plan || null;

  if (!shouldNotify || !email || !plan || ['free', 'credits'].includes(plan)) {
    logger.info('[billing] Loops purchase event skipped', {
      stripeEventId,
      purchaseType,
      emailPresent: Boolean(email),
      plan
    });
    return;
  }

  await trackPlanUpgraded({
    email,
    planName: plan,
    purchaseType,
    billingPeriod: eventProperties.billing_period || 'unknown',
    amount: eventProperties.amount ?? null,
    currency: eventProperties.currency || null,
    stripeEventId
  });

  logger.info('[billing] Loops purchase event succeeded', {
    stripeEventId,
    purchaseType,
    plan
  });
}

function createBillingWebhookHandler({ supabase, getStripe, priceIds = {}, webhookSecret = process.env.STRIPE_WEBHOOK_SECRET }) {
  return async function billingWebhookHandler(req, res) {
    const signature = req.header('stripe-signature');

    if (!webhookSecret) {
      logger.error('[billing] webhook secret not configured');
      return res.status(500).send('Webhook secret not configured');
    }

    if (!signature) {
      logger.warn('[billing] webhook missing signature');
      return res.status(400).send('Missing Stripe signature');
    }

    let event;
    try {
      event = verifyWebhookSignature({
        payload: req.body,
        signature,
        secret: webhookSecret
      });
    } catch (error) {
      logger.warn('[billing] webhook signature verification failed', {
        error: error.message
      });
      return res.status(400).send('Invalid Stripe signature');
    }

    logger.info('[billing] webhook received', {
      stripeEventId: event.id,
      stripeEventType: event.type
    });

    const stripeClient = typeof getStripe === 'function' ? getStripe() : null;

    try {
      let billingTrace = {
        stripe_event_id: event.id,
        stripe_event_type: event.type,
        licenses_updated: false,
        subscriptions_written: false,
        site_subscription_rpc_executed: false,
        site_subscription_rpc_skipped: false,
        site_subscription_rpc_error: null,
        billing_info_source: 'licenses'
      };

      switch (event.type) {
        case 'checkout.session.completed': {
          const session = event.data?.object;
          if (session?.mode === 'payment' && session.payment_status === 'paid') {
            const payload = await buildCheckoutSucceededPayload({
              supabase,
              stripeClient,
              session,
              priceIds
            });
            const entitlementTrace = await reconcileSiteEntitlement({
              supabase,
              stripeEventId: event.id,
              account: payload.account,
              site: payload.site,
              eventProperties: payload.eventProperties,
              subscriptionStatus: 'active'
            });
            billingTrace = {
              ...billingTrace,
              ...entitlementTrace,
              account_id: payload.account?.id || null,
              license_key_present: Boolean(payload.eventProperties.license_key),
              license_key_prefix: maskSecret(payload.eventProperties.license_key || null),
              site_id: payload.site?.id || null,
              site_hash: payload.site?.site_hash || payload.eventProperties.site_hash || null
            };
            await emitPaymentSucceeded({
              stripeEventId: event.id,
              distinctId: payload.distinctId,
              distinctIdSource: payload.distinctIdSource,
              account: payload.account,
              eventProperties: payload.eventProperties
            });
            await emitLoopsPurchaseSucceeded({
              stripeEventId: event.id,
              eventProperties: payload.eventProperties
            });
          } else if (session?.mode === 'subscription') {
            const payload = await buildCheckoutSucceededPayload({
              supabase,
              stripeClient,
              session,
              priceIds
            });
            const entitlementTrace = await reconcileSiteEntitlement({
              supabase,
              stripeEventId: event.id,
              account: payload.account,
              site: payload.site,
              eventProperties: payload.eventProperties,
              subscriptionStatus: 'active'
            });
            billingTrace = {
              ...billingTrace,
              ...entitlementTrace,
              account_id: payload.account?.id || null,
              license_key_present: Boolean(payload.eventProperties.license_key),
              license_key_prefix: maskSecret(payload.eventProperties.license_key || null),
              site_id: payload.site?.id || null,
              site_hash: payload.site?.site_hash || payload.eventProperties.site_hash || null
            };
          }
          logger.info('[billing] webhook_write_trace', billingTrace);
          break;
        }
        case 'invoice.payment_succeeded': {
          const invoice = event.data?.object;
          if (invoice) {
            const payload = await buildInvoiceSucceededPayload({
              supabase,
              stripeClient,
              invoice,
              priceIds
            });
            const firstLinePeriod = Array.isArray(invoice.lines?.data) && invoice.lines.data[0]?.period
              ? invoice.lines.data[0].period
              : null;
            const entitlementTrace = await reconcileSiteEntitlement({
              supabase,
              stripeEventId: event.id,
              account: payload.account,
              site: payload.site,
              eventProperties: payload.eventProperties,
              subscriptionStatus: 'active',
              currentPeriodStart: firstLinePeriod?.start ? new Date(firstLinePeriod.start * 1000).toISOString() : null,
              currentPeriodEnd: firstLinePeriod?.end ? new Date(firstLinePeriod.end * 1000).toISOString() : null
            });
            billingTrace = {
              ...billingTrace,
              ...entitlementTrace,
              account_id: payload.account?.id || null,
              license_key_present: Boolean(payload.eventProperties.license_key),
              license_key_prefix: maskSecret(payload.eventProperties.license_key || null),
              site_id: payload.site?.id || null,
              site_hash: payload.site?.site_hash || payload.eventProperties.site_hash || null
            };
            await emitPaymentSucceeded({
              stripeEventId: event.id,
              distinctId: payload.distinctId,
              distinctIdSource: payload.distinctIdSource,
              account: payload.account,
              eventProperties: payload.eventProperties
            });
            await emitLoopsPurchaseSucceeded({
              stripeEventId: event.id,
              eventProperties: payload.eventProperties
            });
          }
          logger.info('[billing] webhook_write_trace', billingTrace);
          break;
        }
        case 'customer.subscription.updated':
        case 'customer.subscription.deleted': {
          const subscription = event.data?.object;
          if (subscription) {
            const payload = await buildSubscriptionStatusPayload({
              supabase,
              subscription,
              priceIds,
              stripeEventType: event.type
            });
            const entitlementTrace = await reconcileSubscriptionStatus({
              supabase,
              stripeEventId: event.id,
              account: payload.account,
              site: payload.site,
              eventProperties: payload.eventProperties,
              subscription: payload.subscription
            });
            billingTrace = {
              ...billingTrace,
              ...entitlementTrace,
              account_id: payload.account?.id || null,
              license_key_present: Boolean(payload.eventProperties.license_key),
              license_key_prefix: maskSecret(payload.eventProperties.license_key || null),
              site_id: payload.site?.id || null,
              site_hash: payload.site?.site_hash || payload.eventProperties.site_hash || null
            };
          }
          logger.info('[billing] webhook_write_trace', billingTrace);
          break;
        }
        default:
          logger.debug('[billing] webhook event ignored', {
            stripeEventId: event.id,
            stripeEventType: event.type
          });
          break;
      }
    } catch (error) {
      logger.error('[billing] webhook handling failed', {
        stripeEventId: event.id,
        stripeEventType: event.type,
        error: error.message
      });
      return res.status(500).json({
        received: false,
        error: 'WEBHOOK_HANDLING_FAILED'
      });
    }

    return res.status(200).json({ received: true });
  };
}

function createBillingRouter({ supabase, requiredToken, getStripe, priceIds }) {
  const router = express.Router();

  const plans = buildPlansList(priceIds || {});

  router.get('/plans', async (req, res) => {
    const t0 = Date.now();
    try {
      const payload = await getBillingPlansJsonLive(priceIds || {}, getStripe);
      res.set('Cache-Control', 'public, max-age=300');
      res.json(payload);
      logger.info('[billing] GET /plans ok', {
        path: req.path,
        duration_ms: Date.now() - t0,
        plan_count: payload.plans?.length || 0
      });
    } catch (err) {
      logger.error('[billing] GET /plans failed', { error: err.message });
      res.status(500).json({
        success: false,
        error: 'PLANS_UNAVAILABLE',
        code: 'PLANS_UNAVAILABLE',
        message: err.message || 'Unable to load plans'
      });
    }
  });

  function requireBillingAuth(req, res) {
    if (requiredToken) {
      const token = req.header('Authorization')?.replace(/^Bearer\s+/i, '') || req.header('X-API-Key');
      if (token !== requiredToken) {
        res.status(401).json({ error: 'Unauthorized' });
        return false;
      }
    }
    const siteKey = req.header('X-Site-Key');
    if (!siteKey) {
      res.status(400).json({ error: 'Missing X-Site-Key header' });
      return false;
    }
    return true;
  }

  router.get('/info', async (req, res) => {
    const license = req.license;
    if (!license) {
      return res.status(401).json({ success: false, error: 'Authentication required', data: { error: 'Authentication required' } });
    }
    try {
      let billingInfoSource = 'licenses';
      let billingInfoResolutionPath = 'license';
      let billing = buildBillingInfoFromLicense(license);

      // Billing reads should use the live account table plus V2 site billing state.
      // Do not reintroduce public.subscriptions here as a silent fallback.
      if (supabase && license) {
        const resolved = await selectBillingSiteSubscriptionForLicense(supabase, license);
        if (resolved.subscription) {
          billing = buildBillingInfoFromSiteSubscription(resolved.subscription, billing);
          billingInfoSource = 'site_subscriptions';
          billingInfoResolutionPath = resolved.resolutionPath;
        }
      }

      logger.info('[billing] info_source_resolved', {
        source: billingInfoSource,
        resolution_path: billingInfoResolutionPath,
        account_id: license?.id || null,
        licenseKeyPrefix: maskSecret(license?.license_key || null),
        stripe_subscription_id: billing.subscriptionId || null
      });

      return res.json({ success: true, data: { billing } });
    } catch (err) {
      logger.error('[billing] info error', err.message);
      return res.status(500).json({ success: false, error: 'Failed to fetch billing info', data: { error: err.message } });
    }
  });

  router.post('/checkout', async (req, res) => {
    if (!requireBillingAuth(req, res)) return;
    const { priceId, successUrl, cancelUrl } = req.body || {};
    const siteKey = req.header('X-Site-Key');
    const account = req.license || req.user || null;
    const selectedPlan = plans.find((plan) => plan.priceId === priceId) || null;
    const requestedAttribution = normalizeCheckoutAttribution(req.body);

    if (!priceId || !Object.values(priceIds).includes(priceId)) {
      return res.status(400).json({ error: 'Invalid or missing priceId', valid: priceIds });
    }

    let siteRecord = null;
    if (supabase && siteKey) {
      try {
        const resolved = await resolveCanonicalSite(supabase, buildSiteIdentity({
          siteHash: siteKey,
          installUuid: siteKey,
          siteUrl: req.header('X-Site-URL') || null,
          siteFingerprint: req.header('X-Site-Fingerprint') || null
        }), {
          createIfMissing: true,
          legacyLicenseKey: account?.license_key || null,
          account
        });
        siteRecord = resolved.site || null;
      } catch (error) {
        logger.warn('[billing] checkout site lookup failed', {
          siteKey,
          error: error.message
        });
      }

      if (!siteRecord) {
        siteRecord = await findSiteByHash(supabase, siteKey);
      }
    }

    const stripeClient = getStripe();
    if (!stripeClient) {
      return res.status(501).json({ error: 'Stripe not configured' });
    }
    try {
      const selectedPlanId = normalizePlanValue(selectedPlan?.id || resolvePlanFromPriceId(priceIds, priceId) || null);
      const currentPlan = normalizePlanValue(account?.plan || null);
      const mode = selectedPlan?.interval === 'one-time' ? 'payment' : 'subscription';
      const checkoutRateLimit = checkCheckoutRateLimit(req, { siteKey, priceId, selectedPlanId });
      if (!checkoutRateLimit.allowed) {
        logger.warn('[billing] checkout rate limit exceeded', {
          siteKey,
          selectedPlanId,
          account_id: account?.id || null,
          licenseKeyPrefix: maskSecret(account?.license_key || null),
          count: checkoutRateLimit.count,
          limit: checkoutRateLimit.limit
        });
        return res.status(429).json({
          error: 'CHECKOUT_RATE_LIMIT_EXCEEDED',
          code: 'CHECKOUT_RATE_LIMIT_EXCEEDED',
          message: 'Too many checkout attempts. Please wait a few minutes before trying again.',
          retry_after: checkoutRateLimit.retryAfterSeconds
        });
      }
      let existingSubscription = null;
      if (mode === 'subscription') {
        const existingBilling = await selectBillingSiteSubscriptionForLicense(supabase, account);
        existingSubscription = existingBilling.subscription;
        const existingCustomerId = existingSubscription?.stripe_customer_id || account?.stripe_customer_id || null;
        if (existingSubscription && existingCustomerId) {
          if (!stripeClient.billingPortal?.sessions?.create) {
            logger.warn('[billing] active subscription found but billing portal unavailable', {
              account_id: account?.id || null,
              licenseKeyPrefix: maskSecret(account?.license_key || null),
              site_id: existingSubscription.site_id || siteRecord?.id || null,
              stripeCustomerId: existingCustomerId,
              stripeSubscriptionId: existingSubscription.stripe_subscription_id || null
            });
            return res.status(409).json({
              success: false,
              error: 'ACTIVE_SUBSCRIPTION_EXISTS',
              message: 'An active subscription already exists for this license.'
            });
          }

          const portalSession = await stripeClient.billingPortal.sessions.create({
            customer: existingCustomerId,
            return_url: cancelUrl || successUrl || `${process.env.FRONTEND_URL || 'https://example.com'}/billing`
          });
          logger.info('[billing] active subscription checkout redirected to portal', {
            account_id: account?.id || null,
            licenseKeyPrefix: maskSecret(account?.license_key || null),
            site_id: existingSubscription.site_id || siteRecord?.id || null,
            stripeCustomerId: existingCustomerId,
            stripeSubscriptionId: existingSubscription.stripe_subscription_id || null,
            billing_info_source: existingBilling.resolutionPath
          });
          return res.json({
            success: true,
            url: portalSession.url,
            portal: true,
            customerId: existingCustomerId,
            subscriptionId: existingSubscription.stripe_subscription_id || null
          });
        }
      }

      // Enforce the single-site subscription limit — but ONLY when there is a
      // genuinely active subscription on the same plan. This previously keyed off
      // the dual-written legacy `licenses.plan` column, which can drift out of
      // sync with the real entitlement: a free account whose legacy row still
      // read `pro` got a false 403 here, dead-ending the Pro upgrade while
      // Starter/credits worked. `existingSubscription` comes from
      // `site_subscriptions` filtered to active statuses, so it's the source of
      // truth. (The active-sub-with-customer case already returned a billing
      // portal redirect above; this only guards the rare active-sub-without-
      // resolvable-customer edge case, preventing a duplicate subscription.)
      if (mode === 'subscription'
        && existingSubscription
        && normalizePlanValue(existingSubscription.plan_id) === selectedPlanId) {
        return res.status(403).json({
          error: 'SITE_LIMIT_EXCEEDED',
          message: 'This subscription plan is limited to 1 site per subscription.',
          plan: selectedPlanId
        });
      }

      const purchaseType = inferPurchaseType({
        eventType: 'checkout.session.completed',
        paymentMode: mode,
        stripeSubscriptionId: null,
        billingReason: mode === 'subscription' ? 'subscription_create' : 'manual',
        plan: selectedPlanId,
        currentPlan,
        metadataPurchaseType: null
      });
      const checkoutMetadata = {
        account_id: sanitizeStripeMetadataValue(account?.id) || requestedAttribution.accountId,
        license_key: sanitizeStripeMetadataValue(account?.license_key)
          || sanitizeStripeMetadataValue(siteRecord?.license_key)
          || requestedAttribution.licenseKey,
        site_id: sanitizeStripeMetadataValue(siteRecord?.id) || requestedAttribution.siteId,
        site_hash: sanitizeStripeMetadataValue(siteRecord?.site_hash)
          || sanitizeStripeMetadataValue(siteKey)
          || requestedAttribution.siteHash,
        user_id: sanitizeStripeMetadataValue(req.user?.id)
          || requestedAttribution.userId
          || sanitizeStripeMetadataValue(account?.id),
        email: sanitizeStripeMetadataValue(account?.email, { lowercase: true }) || requestedAttribution.email,
        plan: selectedPlanId || undefined,
        current_plan: currentPlan || undefined,
        billing_interval: resolveCheckoutBillingInterval(selectedPlan, selectedPlanId),
        purchase_type: purchaseType !== 'unknown' ? purchaseType : undefined,
        trigger_feature: requestedAttribution.triggerFeature,
        trigger_location: requestedAttribution.triggerLocation,
        source_page: requestedAttribution.sourcePage,
        target_plan: selectedPlanId || requestedAttribution.targetPlan || undefined,
        source: 'app'
      };
      const metadata = Object.fromEntries(
        Object.entries(checkoutMetadata).filter(([, value]) => value !== undefined && value !== null && value !== '')
      );
      const checkoutPayload = {
        mode,
        line_items: [{ price: priceId, quantity: 1 }],
        success_url: successUrl || `${process.env.FRONTEND_URL || 'https://example.com'}/billing/success`,
        cancel_url: cancelUrl || `${process.env.FRONTEND_URL || 'https://example.com'}/billing/cancel`,
        client_reference_id: account?.id ? String(account.id) : undefined,
        metadata
      };

      if (account?.stripe_customer_id) {
        checkoutPayload.customer = account.stripe_customer_id;
      } else if (account?.email) {
        checkoutPayload.customer_email = account.email;
      }

      if (mode === 'subscription') {
        checkoutPayload.subscription_data = { metadata };
      } else if (mode === 'payment') {
        checkoutPayload.payment_intent_data = { metadata };
      }

      const idempotencyKey = buildCheckoutIdempotencyKey({
        licenseKey: metadata.license_key,
        siteId: metadata.site_id,
        priceId,
        billingCycle: metadata.billing_interval,
        attemptId: mode === 'payment' && selectedPlanId === 'credits' ? crypto.randomUUID() : null
      });
      const session = await stripeClient.checkout.sessions.create(checkoutPayload, { idempotencyKey });
      res.json({ success: true, url: session.url, sessionId: session.id });
    } catch (error) {
      logger.error('[billing] checkout error', error.message);
      res.status(500).json({ error: 'Failed to create checkout session' });
    }
  });

  router.post('/portal', async (req, res) => {
    if (!requireBillingAuth(req, res)) return;
    const { returnUrl, customerId } = req.body || {};
    const account = req.license || req.user || null;
    const stripeClient = getStripe();
    if (!stripeClient) {
      return res.status(501).json({ error: 'Stripe not configured' });
    }

    let resolvedCustomerId = customerId || account?.stripe_customer_id || null;
    let resolvedSubscriptionId = account?.stripe_subscription_id || null;
    let resolutionSource = customerId ? 'request' : account?.stripe_customer_id ? 'account' : 'unresolved';

    if (!resolvedCustomerId && supabase && account) {
      const resolved = await selectBillingSiteSubscriptionForLicense(supabase, account);
      if (resolved.subscription?.stripe_customer_id) {
        resolvedCustomerId = resolved.subscription.stripe_customer_id;
        resolvedSubscriptionId = resolved.subscription.stripe_subscription_id || resolvedSubscriptionId;
        resolutionSource = `site_subscriptions:${resolved.resolutionPath}`;
      }
    }

    if (!resolvedCustomerId) {
      logger.warn('[billing] portal customer unresolved', {
        account_id: account?.id || null,
        licenseKeyPrefix: maskSecret(account?.license_key || null),
        source: resolutionSource
      });
      return res.status(409).json({
        error: 'Billing portal is unavailable because this account is not linked to a Stripe customer.',
        code: 'billing_not_linked'
      });
    }

    try {
      const session = await stripeClient.billingPortal.sessions.create({
        customer: resolvedCustomerId,
        return_url: returnUrl || `${process.env.FRONTEND_URL || 'https://example.com'}/billing`
      });
      res.json({
        success: true,
        url: session.url,
        customerId: resolvedCustomerId,
        subscriptionId: resolvedSubscriptionId,
        source: resolutionSource
      });
    } catch (error) {
      logger.error('[billing] portal error', error.message);
      res.status(500).json({ error: 'Failed to create portal session' });
    }
  });

  router.get('/subscription', async (req, res) => {
    if (!requireBillingAuth(req, res)) return;
    const siteKey = req.header('X-Site-Key');
    const freePlan = { plan: 'free', status: 'free', billingCycle: null, nextBillingDate: null, subscriptionId: null, cancelAtPeriodEnd: false };
    try {
      if (!supabase) return res.json({ success: true, data: freePlan });

      const resolved = await resolveCanonicalSite(supabase, buildSiteIdentity({
        siteHash: siteKey,
        installUuid: siteKey,
        siteUrl: req.header('X-Site-URL') || null,
        siteFingerprint: req.header('X-Site-Fingerprint') || null
      }), {
        createIfMissing: true,
        legacyLicenseKey: req.license?.license_key || null,
        account: req.user || req.license || null,
        requestId: req.id || null
      });

      if (resolved.error) {
        logger.error('[site] billing_subscription_site_healing_failed', {
          request_id: req.id || null,
          account_id: req.user?.id || req.license?.id || null,
          site_hash: siteKey || null,
          site_url: req.header('X-Site-URL') || null,
          error: resolved.error,
          site_write_error: resolved.diagnostics?.site_write_error || null,
          membership_error: resolved.diagnostics?.membership?.error || null
        });
      }

      const fallbackSite = !resolved.site && siteKey
        ? await findSiteByHash(supabase, siteKey)
        : null;
      const effectiveSite = resolved.site || fallbackSite;

      if (!effectiveSite) return res.json({ success: true, data: freePlan });

      const siteSubscription = await selectActiveSiteSubscription(supabase, effectiveSite.id);
      if (siteSubscription) {
        logger.info('[billing] subscription_source_resolved', {
          source: 'site_subscriptions',
          site_id: effectiveSite.id,
          site_hash: effectiveSite.site_hash || null,
          stripe_subscription_id: siteSubscription.stripe_subscription_id || null
        });
        return res.json({
          success: true,
          data: {
            plan: siteSubscription.plan_id || 'free',
            status: siteSubscription.status || 'active',
            billingCycle: siteSubscription.billing_interval || 'month',
            nextBillingDate: siteSubscription.current_period_end || null,
            subscriptionId: siteSubscription.stripe_subscription_id || null,
            cancelAtPeriodEnd: siteSubscription.cancel_at_period_end || false
          }
        });
      }

      const { data: license } = await supabase
        .from('licenses')
        .select('plan, status, billing_cycle, stripe_subscription_id')
        .eq('license_key', effectiveSite.license_key)
        .maybeSingle();

      logger.info('[billing] subscription_source_resolved', {
        source: 'licenses',
        site_id: effectiveSite.id,
        site_hash: effectiveSite.site_hash || null,
        stripe_subscription_id: license?.stripe_subscription_id || null
      });

      res.json({
        success: true,
        data: {
          plan: license?.plan || 'free',
          status: license?.status || 'active',
          billingCycle: license?.billing_cycle || 'month',
          nextBillingDate: null,
          subscriptionId: license?.stripe_subscription_id || null,
          cancelAtPeriodEnd: false
        }
      });
    } catch (error) {
      logger.error('[billing] subscription fetch error', error.message);
      res.status(500).json({ error: 'Failed to fetch subscription' });
    }
  });

  return router;
}

module.exports = {
  createBillingRouter,
  createBillingWebhookHandler
};
