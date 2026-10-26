const express = require('express');
const crypto = require('crypto');
// Stripe errors can echo customer emails: mask them in every billing log line.
const { redactStripeIds, redactStripeIdsInString } = require('../lib/redact');
const { SIGN_IN_REQUIRED_BODY, sendSignInRequired } = require('../lib/signInRequired');

// Billing logs: emails masked (withEmailRedaction), then Stripe ids masked.
const logger = (() => {
  const base = require('../lib/logger').withEmailRedaction();
  const wrap = (level) => (...args) => base[level](...args.map((arg) => redactStripeIds(arg)));
  return { ...base, info: wrap('info'), warn: wrap('warn'), error: wrap('error'), debug: wrap('debug') };
})();
const {
  resolveBillingCountry,
  resolveBillingCountryWithSource,
  resolveBillingCurrency,
  selectCatalogPriceIds,
  listConfiguredPriceIds,
  isUsdPriceId,
  canonicalizePlanKey,
  findGbpEquivalentPriceId
} = require('../lib/billingCurrency');
const { verifyWebhookSignature } = require('../lib/stripe');
const emailService = require('../lib/email');
const { captureServerEvent, identifyServerUser } = require('../lib/posthog');
const {
  emitCanonicalBillingEvents,
  emitPaymentFailedEvent,
  resolveAttributionFromMetadata
} = require('../services/billingTelemetry');
const {
  trackPaymentFailed,
  trackPaymentSucceeded,
  trackPlanUpgraded
} = require('../../src/services/loops');
const { buildSiteIdentity } = require('../lib/siteIdentity');
const {
  reconcileBillingEntitlement,
  resolveCanonicalSite,
  selectActiveSiteSubscription,
  syncLegacySitePointers
} = require('../services/siteQuota');
const { getBillingPlansJson, getBillingPlansJsonLive, buildPlansList } = require('../services/billingPlansCatalog');
const { getLimits } = require('../services/planLimits');

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
const RECOVERABLE_PAYMENT_FAILURE_CODES = new Set([
  'authentication_required',
  'card_declined',
  'expired_card',
  'incorrect_cvc',
  'incorrect_zip',
  'insufficient_funds',
  'processing_error'
]);
const SUPPRESSED_PAYMENT_FAILURE_CODES = new Set([
  'incorrect_number',
  'invalid_number',
  'fraudulent',
  'lost_card',
  'pickup_card',
  'stolen_card'
]);
const STRIPE_METADATA_MAX_LENGTH = 500;
const CHECKOUT_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const CHECKOUT_LINK_EMAIL_LIMIT = 3;
const checkoutRateBuckets = new Map();

function normalizeStripeId(value) {
  if (typeof value === 'string' && value) return value;
  if (value && typeof value === 'object' && typeof value.id === 'string' && value.id) {
    return value.id;
  }
  return null;
}

// Stripe API >= 2025-03-31 (basil) removed invoice.subscription; the id lives under
// invoice.parent.subscription_details.subscription.
function resolveInvoiceSubscriptionId(invoice) {
  return normalizeStripeId(invoice?.subscription)
    || normalizeStripeId(invoice?.parent?.subscription_details?.subscription)
    || null;
}

// Stripe API >= 2025-03-31 (basil) moved current_period_start/end from the
// subscription to each subscription item. Prefer the top-level value (older API
// versions, and the 2022-11-15 pinned client), then fall back to the first item.
function resolveSubscriptionPeriod(subscription) {
  const firstItem = Array.isArray(subscription?.items?.data) ? subscription.items.data[0] : null;
  return {
    start: subscription?.current_period_start || firstItem?.current_period_start || null,
    end: subscription?.current_period_end || firstItem?.current_period_end || null
  };
}

function toIsoFromUnix(seconds) {
  return typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0
    ? new Date(seconds * 1000).toISOString()
    : null;
}

function resolvePlanFromPriceId(priceIds = {}, priceId) {
  if (!priceId) return null;
  const match = Object.entries(priceIds).find(([, configuredPriceId]) => configuredPriceId === priceId);
  return match ? canonicalizePlanKey(match[0]) : null;
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

function normalizeEmail(email) {
  if (typeof email !== 'string') return null;
  const normalized = email.trim().toLowerCase();
  if (!normalized || !normalized.includes('@')) return null;
  return normalized;
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

// True when a Stripe customer id is the account's own: on the account row, or
// on a site subscription for a site on the account's licence or owned by the
// account. Site membership does not count. Any lookup failure counts as not owned.
async function isCustomerOwnedByAccount(supabase, account, customerId) {
  if (!account || typeof customerId !== 'string' || !customerId) return false;
  if (account.stripe_customer_id && account.stripe_customer_id === customerId) return true;
  if (!supabase) return false;
  try {
    const { data: subscriptions } = await supabase
      .from('site_subscriptions')
      .select('site_id')
      .eq('stripe_customer_id', customerId);
    const siteIds = [...new Set((subscriptions || []).map((row) => row?.site_id).filter(Boolean))];
    if (siteIds.length === 0) return false;
    const { data: sites } = await supabase
      .from('sites')
      .select('id, license_key, owner_user_id')
      .in('id', siteIds);
    return (sites || []).some((site) => siteOwnedByAccount(site, account));
  } catch (_error) {
    return false;
  }
}

// Billing account data needs a signed-in account (JWT) or a licence key the
// caller sent and that matched a licence exactly. Site headers (site key,
// hash, URL, fingerprint) identify a site, not who may manage its billing.
const ACCOUNT_AUTH_METHODS = new Set(['jwt', 'license']);
function hasAccountCredential(req) {
  const account = req.user || req.license || null;
  return Boolean(account && (account.id || account.license_key) && ACCOUNT_AUTH_METHODS.has(req.authMethod));
}

const authRequired = sendSignInRequired;

const maskStripeId = (value) => (typeof value === 'string' ? redactStripeIdsInString(value) : value ?? null);

// A site is the caller's when it is on the caller's licence or the caller
// owns it. Site membership does not count for billing.
function siteOwnedByAccount(site, account) {
  if (!site || !account) return false;
  if (account.license_key && site.license_key === account.license_key) return true;
  return Boolean(account.id && site.owner_user_id === account.id);
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

function canonicalizeForHash(value) {
  if (Array.isArray(value)) return value.map(canonicalizeForHash);
  if (value && typeof value === 'object') {
    return Object.keys(value)
      .sort()
      .reduce((acc, key) => {
        if (value[key] !== undefined) acc[key] = canonicalizeForHash(value[key]);
        return acc;
      }, {});
  }
  return value;
}

function hashCheckoutParams(params) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(canonicalizeForHash(params || {})))
    .digest('hex');
}

// Stripe rejects a reused idempotency key whose request params differ (for 24h),
// so the key must cover the full session params. It stays deterministic so a
// true double-click (identical params) still dedupes to the same session.
function buildCheckoutIdempotencyKey({ licenseKey, siteId, priceId, billingCycle, attemptId, checkoutParams }) {
  const stablePayload = [
    licenseKey || 'anonymous',
    siteId || 'unknown-site',
    priceId || 'unknown-price',
    billingCycle || 'unknown-cycle',
    hashCheckoutParams(checkoutParams)
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

function resolvePaymentFailureCode(paymentIntent = {}) {
  return paymentIntent.last_payment_error?.code
    || paymentIntent.last_payment_error?.decline_code
    || paymentIntent.cancellation_reason
    || null;
}

function classifyPaymentFailure({ failureCode, declineCode }) {
  const normalizedFailureCode = failureCode ? String(failureCode).trim().toLowerCase() : null;
  const normalizedDeclineCode = declineCode ? String(declineCode).trim().toLowerCase() : null;
  const codes = [normalizedFailureCode, normalizedDeclineCode].filter(Boolean);

  if (codes.some((code) => SUPPRESSED_PAYMENT_FAILURE_CODES.has(code))) {
    return {
      recoverability: 'suppressed',
      suppressionReason: 'suspicious_failure_code'
    };
  }

  if (codes.some((code) => RECOVERABLE_PAYMENT_FAILURE_CODES.has(code))) {
    return {
      recoverability: 'recoverable',
      suppressionReason: null
    };
  }

  return {
    recoverability: 'unknown',
    suppressionReason: 'unclassified_failure_code'
  };
}

function getExpandedLatestCharge(paymentIntent = {}) {
  if (paymentIntent.latest_charge && typeof paymentIntent.latest_charge === 'object') {
    return paymentIntent.latest_charge;
  }
  if (Array.isArray(paymentIntent.charges?.data) && paymentIntent.charges.data[0]) {
    return paymentIntent.charges.data[0];
  }
  return null;
}

function resolvePaymentFailureEmail(paymentIntent = {}, charge = null, metadata = {}) {
  return normalizeEmail(paymentIntent.receipt_email)
    || normalizeEmail(paymentIntent.customer?.email)
    || normalizeEmail(paymentIntent.last_payment_error?.payment_method?.billing_details?.email)
    || normalizeEmail(paymentIntent.payment_method?.billing_details?.email)
    || normalizeEmail(charge?.billing_details?.email)
    || normalizeEmail(extractMetadataValue(metadata, ['email', 'customer_email', 'customerEmail']));
}

function normalizeCheckoutAttribution(body = {}) {
  const targetPlan = sanitizeStripeMetadataValue(body.target_plan);

  return {
    accountId: sanitizeStripeMetadataValue(body.account_id),
    userId: sanitizeStripeMetadataValue(body.user_id),
    licenseKey: sanitizeStripeMetadataValue(body.license_key),
    siteId: sanitizeStripeMetadataValue(body.site_id),
    siteHash: sanitizeStripeMetadataValue(body.site_hash),
    siteInstallId: sanitizeStripeMetadataValue(body.site_install_id),
    email: sanitizeStripeMetadataValue(body.email, { lowercase: true }),
    triggerFeature: sanitizeStripeMetadataValue(body.trigger_feature),
    triggerLocation: sanitizeStripeMetadataValue(body.trigger_location),
    sourcePage: sanitizeStripeMetadataValue(body.source_page),
    targetPlan: normalizePlanValue(targetPlan) || targetPlan,
    source: sanitizeStripeMetadataValue(body.source),
    utmSource: sanitizeStripeMetadataValue(body.utm_source),
    utmMedium: sanitizeStripeMetadataValue(body.utm_medium),
    utmCampaign: sanitizeStripeMetadataValue(body.utm_campaign),
    utmContent: sanitizeStripeMetadataValue(body.utm_content),
    utmTerm: sanitizeStripeMetadataValue(body.utm_term),
    referrer: sanitizeStripeMetadataValue(body.referrer),
    landingPage: sanitizeStripeMetadataValue(body.landing_page),
    acquisitionChannel: sanitizeStripeMetadataValue(body.acquisition_channel),
    pluginVersion: sanitizeStripeMetadataValue(body.plugin_version),
    country: sanitizeStripeMetadataValue(body.country)
  };
}

function resolveAttributionProperties(metadata = {}) {
  const attribution = resolveAttributionFromMetadata(metadata);
  return {
    trigger_feature: extractMetadataValue(metadata, ['trigger_feature', 'triggerFeature']),
    trigger_location: extractMetadataValue(metadata, ['trigger_location', 'triggerLocation']),
    source_page: extractMetadataValue(metadata, ['source_page', 'sourcePage']),
    target_plan: extractMetadataValue(metadata, ['target_plan', 'targetPlan']),
    utm_source: attribution.utm_source,
    utm_medium: attribution.utm_medium,
    utm_campaign: attribution.utm_campaign,
    utm_content: attribution.utm_content,
    utm_term: attribution.utm_term,
    referrer: attribution.referrer,
    landing_page: attribution.landing_page,
    acquisition_channel: attribution.acquisition_channel,
    plugin_version: extractMetadataValue(metadata, ['plugin_version', 'pluginVersion']),
    site_install_id: extractMetadataValue(metadata, ['site_install_id', 'siteInstallId']),
    country: extractMetadataValue(metadata, ['country'])
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

  if (eventType === 'invoice.payment_succeeded' || eventType === 'invoice.paid') {
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

function inferPaymentRecovered(invoice) {
  if (!invoice) return false;
  if (typeof invoice.attempt_count === 'number' && invoice.attempt_count > 1) {
    return true;
  }
  return false;
}

function resolveCommercialPlan({ metadata, context, accountPlan, preferPricePlan = false }) {
  // Subscription metadata is written once at checkout, so after a portal
  // upgrade/downgrade its `plan` is stale. For subscription-backed events the
  // configured price mapping is the source of truth when it resolves.
  if (preferPricePlan && context?.pricePlan) {
    return normalizePlanValue(context.pricePlan);
  }
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
  // Stripe API >= 2025-03-31 (basil) moved invoice line prices to pricing.price_details.
  const pricingDetails = lineItem?.pricing?.price_details || null;
  const priceId = normalizeStripeId(lineItem?.price)
    || normalizeStripeId(lineItem?.price?.id)
    || normalizeStripeId(pricingDetails?.price);
  const expandedPricingPrice = pricingDetails?.price && typeof pricingDetails.price === 'object'
    ? pricingDetails.price
    : null;
  const rawProduct = lineItem?.price?.product || pricingDetails?.product || expandedPricingPrice?.product;
  const productId = normalizeStripeId(rawProduct);
  const recurringInterval = lineItem?.price?.recurring?.interval
    || expandedPricingPrice?.recurring?.interval
    || null;

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

function isProrationLine(line) {
  return line?.proration === true
    || line?.parent?.subscription_item_details?.proration === true;
}

function getLineAmount(line) {
  return typeof line?.amount === 'number' ? line.amount : null;
}

// Pick the invoice line that reflects what the customer now pays for. On an
// upgrade/proration invoice the first line is usually the negative
// "Unused time on <old plan>" credit, which must not decide the plan.
function selectPrimaryInvoiceLine(lines, preferredPriceId = null) {
  if (!Array.isArray(lines) || !lines.length) return null;
  const amountOf = (line) => getLineAmount(line) ?? 0;
  if (preferredPriceId) {
    const match = lines.find((line) => (
      getPriceContextFromLineItem(line, {}).priceId === preferredPriceId && amountOf(line) >= 0
    ));
    if (match) return match;
  }
  return lines.find((line) => !isProrationLine(line) && amountOf(line) > 0)
    || lines.find((line) => amountOf(line) > 0)
    || lines.find((line) => !isProrationLine(line) && amountOf(line) >= 0)
    || lines[0];
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

function normalizeEmailForMatch(email) {
  return typeof email === 'string' ? email.trim().toLowerCase() : '';
}

function escapeLikePattern(value) {
  // Escape LIKE metacharacters (\\, %, _) plus `*`, which PostgREST treats as a
  // `%` wildcard alias in like/ilike filters, so ILIKE is a case-insensitive exact match.
  // Candidates are re-verified in JS below, so an escaped `*` can only cause a miss,
  // never a wrong link.
  return String(value).replace(/[\\%_*]/g, (ch) => `\\${ch}`);
}

async function findAccountByEmail(supabase, email) {
  const trimmedEmail = typeof email === 'string' ? email.trim() : '';
  const normalizedEmail = normalizeEmailForMatch(email);
  if (!supabase || !normalizedEmail) return null;

  // `licenses` is the canonical account table in this backend.
  // 1) Exact match on the trimmed (case-preserved) Stripe email wins outright.
  const { data, error } = await supabase
    .from('licenses')
    .select(ACCOUNT_SELECT)
    .eq('email', trimmedEmail)
    .maybeSingle();

  if (error) {
    logger.warn('[billing] account lookup by email failed', {
      email: normalizedEmail,
      error: error.message
    });
    return null;
  }

  if (data) return data;

  // 2) Case-insensitive exact match (ILIKE with escaped metacharacters), re-verified
  //    with lower(trim()) in JS. If 2+ accounts match, link neither.
  const { data: candidates, error: ilikeError } = await supabase
    .from('licenses')
    .select(ACCOUNT_SELECT)
    .ilike('email', escapeLikePattern(normalizedEmail))
    .limit(3);

  if (ilikeError) {
    logger.warn('[billing] case-insensitive account lookup by email failed', {
      email: normalizedEmail,
      error: ilikeError.message
    });
    return null;
  }

  const matches = (candidates || []).filter(
    (row) => normalizeEmailForMatch(row?.email) === normalizedEmail
  );

  if (matches.length > 1) {
    logger.warn('[billing] ambiguous case-insensitive email match; not linking', {
      email: normalizedEmail,
      matches: matches.length
    });
    return null;
  }

  return matches[0] || null;
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
    return {
      ...mergeCommercialContext(embeddedContext, metadataContext, { source: 'session.line_items' }),
      pricePlan: embeddedContext.plan || null
    };
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
    return {
      ...mergeCommercialContext(resolvedContext, metadataContext, { source: 'stripe.list_line_items' }),
      pricePlan: resolvedContext.plan || null
    };
  } catch (error) {
    logger.warn('[billing] webhook line item lookup failed', {
      sessionId: session.id,
      error: error.message
    });
    return mergeCommercialContext(metadataContext, { source: 'lookup_failed' });
  }
}

async function loadInvoiceLineContext(stripeClient, invoice, priceIds, metadataOverride, subscriptionSnapshot = null) {
  const metadata = metadataOverride || invoice?.metadata || {};
  const metadataContext = {
    priceId: extractMetadataValue(metadata, ['price_id', 'priceId']),
    productId: extractMetadataValue(metadata, ['product_id', 'productId']),
    recurringInterval: extractMetadataValue(metadata, ['billing_interval', 'billingInterval']),
    plan: extractMetadataValue(metadata, ['plan', 'plan_type', 'planType']),
    source: 'metadata'
  };

  const subscriptionContext = subscriptionSnapshot?.priceId
    ? {
      priceId: subscriptionSnapshot.priceId,
      productId: subscriptionSnapshot.productId,
      recurringInterval: subscriptionSnapshot.recurringInterval,
      plan: resolvePlanFromPriceId(priceIds, subscriptionSnapshot.priceId)
    }
    : null;
  const preferredPriceId = subscriptionSnapshot?.priceId || null;
  const withPricePlan = (merged, lineContext) => ({
    ...merged,
    pricePlan: subscriptionContext?.plan || lineContext?.plan || null
  });

  const embeddedItems = Array.isArray(invoice?.lines?.data) ? invoice.lines.data : null;
  if (embeddedItems?.length) {
    const embeddedContext = getPriceContextFromLineItem(
      selectPrimaryInvoiceLine(embeddedItems, preferredPriceId),
      priceIds
    );
    const ordered = subscriptionContext?.plan
      ? [subscriptionContext, embeddedContext]
      : [embeddedContext, subscriptionContext];
    return withPricePlan(
      mergeCommercialContext(...ordered, metadataContext, { source: 'invoice.lines' }),
      embeddedContext
    );
  }

  if (!stripeClient || !invoice?.id) {
    return withPricePlan(mergeCommercialContext(subscriptionContext, metadataContext), null);
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
    const primaryLineItem = selectPrimaryInvoiceLine(expandedInvoice?.lines?.data, preferredPriceId);
    const resolvedContext = getPriceContextFromLineItem(primaryLineItem, priceIds);
    const ordered = subscriptionContext?.plan
      ? [subscriptionContext, resolvedContext]
      : [resolvedContext, subscriptionContext];
    return withPricePlan(
      mergeCommercialContext(...ordered, metadataContext, { source: 'stripe.retrieve_invoice' }),
      resolvedContext
    );
  } catch (error) {
    logger.warn('[billing] webhook invoice enrichment lookup failed', {
      invoiceId: invoice.id,
      error: error.message
    });
    return mergeCommercialContext(metadataContext, { source: 'lookup_failed' });
  }
}

async function loadSubscriptionSnapshot(stripeClient, stripeSubscriptionId, livemode) {
  if (!stripeClient?.subscriptions?.retrieve || !stripeSubscriptionId) {
    return null;
  }

  if (!isStripeModeCompatible(Boolean(livemode))) {
    return null;
  }

  try {
    const subscription = await stripeClient.subscriptions.retrieve(stripeSubscriptionId);
    if (!subscription) return null;
    const firstItem = Array.isArray(subscription.items?.data) ? subscription.items.data[0] : null;
    const priceContext = getPriceContextFromLineItem(firstItem, {});
    return {
      metadata: mergeStripeMetadata(subscription.metadata),
      priceId: priceContext.priceId,
      productId: priceContext.productId,
      recurringInterval: priceContext.recurringInterval
    };
  } catch (error) {
    logger.warn('[billing] subscription snapshot lookup failed', {
      stripeSubscriptionId,
      error: error.message
    });
    return null;
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

async function resolveInvoiceMetadata(stripeClient, invoice, { subscriptionSnapshot } = {}) {
  const stripeSubscriptionId = resolveInvoiceSubscriptionId(invoice);
  const stripeCustomerId = normalizeStripeId(invoice?.customer);
  const invoiceMetadata = mergeStripeMetadata(
    invoice?.metadata,
    invoice?.parent?.subscription_details?.metadata,
    invoice?.subscription_details?.metadata
  );
  const subscriptionMetadata = subscriptionSnapshot
    ? subscriptionSnapshot.metadata
    : await loadSubscriptionMetadata(stripeClient, stripeSubscriptionId, invoice?.livemode);
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
  // For subscriptions the purchased recurring price decides the plan: a Starter
  // price is Starter even when session metadata or the account's legacy plan
  // says 'pro'. One-time payments keep the explicit metadata plan.
  const plan = resolveCommercialPlan({
    metadata,
    context,
    accountPlan: identity.account?.plan || null,
    preferPricePlan: session.mode === 'subscription'
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

async function buildInvoiceSucceededPayload({
  supabase,
  stripeClient,
  invoice,
  priceIds,
  stripeEventType = 'invoice.payment_succeeded'
}) {
  const stripeSubscriptionId = resolveInvoiceSubscriptionId(invoice);
  const subscriptionSnapshot = await loadSubscriptionSnapshot(stripeClient, stripeSubscriptionId, invoice.livemode);
  const metadata = await resolveInvoiceMetadata(stripeClient, invoice, { subscriptionSnapshot });
  const stripeCustomerId = normalizeStripeId(invoice.customer);
  const identity = await resolveIdentityContext({
    supabase,
    metadata,
    email: invoice.customer_email || extractMetadataValue(metadata, ['email']),
    stripeCustomerId,
    stripeSubscriptionId
  });
  const context = await loadInvoiceLineContext(stripeClient, invoice, priceIds, metadata, subscriptionSnapshot);
  const licenseKey = identity.licenseKey;
  const plan = resolveCommercialPlan({
    metadata,
    context,
    accountPlan: identity.account?.plan || null,
    preferPricePlan: Boolean(stripeSubscriptionId)
  });
  const currentPlan = resolveCurrentPlan({
    metadata,
    accountPlan: identity.account?.plan || null
  });
  const currency = normalizeCurrency(invoice.currency);
  const amount = resolveAmount(invoice.amount_paid, currency);
  const purchaseType = inferPurchaseType({
    eventType: stripeEventType,
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
      stripe_event_type: stripeEventType,
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
      is_trial_conversion: inferTrialConversion({ metadata, purchaseType }),
      payment_recovered: inferPaymentRecovered(invoice)
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
  const subscriptionPeriod = resolveSubscriptionPeriod(subscription);
  const plan = resolveCommercialPlan({
    metadata,
    context: { ...context, pricePlan: context.plan },
    accountPlan: identity.account?.plan || null,
    preferPricePlan: true
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
      current_period_start: toIsoFromUnix(subscriptionPeriod.start),
      current_period_end: toIsoFromUnix(subscriptionPeriod.end),
      canceled_at: subscription?.canceled_at
        ? new Date(subscription.canceled_at * 1000).toISOString()
        : null
    }
  };
}

/**
 * Another still-active paid subscription for the same site or Stripe customer,
 * other than the one being canceled. Used so canceling or deleting an old
 * subscription never drops a paying site/account back to free.
 */
async function findOtherActivePaidSubscription(supabase, { account, site, stripeSubscriptionId }) {
  const lookups = [
    ['site_id', site?.id || null],
    ['stripe_customer_id', account?.stripe_customer_id || null]
  ].filter(([, value]) => Boolean(value));
  const seen = new Set();
  for (const [column, value] of lookups) {
    let rows = [];
    try {
      const { data, error } = await supabase
        .from('site_subscriptions')
        .select(SITE_SUBSCRIPTION_SELECT)
        .eq(column, value)
        .in('status', ACTIVE_BILLING_STATUSES);
      if (error) {
        logger.warn('[billing] other active subscription lookup failed', { column, error: error.message });
        continue;
      }
      rows = Array.isArray(data) ? data : (data ? [data] : []);
    } catch (error) {
      logger.warn('[billing] other active subscription lookup failed', { column, error: error.message });
      continue;
    }
    for (const row of rows) {
      if (!row || seen.has(row.id)) continue;
      seen.add(row.id);
      const plan = normalizePlanValue(row.plan_id);
      if (
        row.stripe_subscription_id
        && row.stripe_subscription_id !== stripeSubscriptionId
        && ACTIVE_BILLING_STATUSES.includes(String(row.status || '').toLowerCase())
        && plan
        && !['free', 'credits', 'trial'].includes(plan)
      ) {
        return { ...row, plan_id: plan };
      }
    }
  }
  return null;
}

async function syncCanceledSubscriptionPointers(supabase, { account, site, stripeSubscriptionId }) {
  const updates = {};
  const otherActive = await findOtherActivePaidSubscription(supabase, { account, site, stripeSubscriptionId });
  if (otherActive) {
    updates.other_active_subscription = {
      stripe_subscription_id: otherActive.stripe_subscription_id,
      plan_id: otherActive.plan_id,
      site_id: otherActive.site_id || null
    };
    logger.info('[billing] canceled subscription has an active replacement; keeping paid entitlement', {
      account_id: account?.id || null,
      site_id: site?.id || null,
      canceled_subscription_id: stripeSubscriptionId || null,
      active_subscription_id: otherActive.stripe_subscription_id,
      active_plan_id: otherActive.plan_id
    });
  }

  if (account?.id && account.stripe_subscription_id === stripeSubscriptionId) {
    // Repoint to the subscription that is still paying instead of dropping to free.
    const licensePayload = otherActive
      ? {
        plan: otherActive.plan_id,
        stripe_subscription_id: otherActive.stripe_subscription_id
      }
      : {
        plan: 'free',
        billing_cycle: 'monthly',
        stripe_subscription_id: null
      };
    const { error } = await supabase
      .from('licenses')
      .update(licensePayload)
      .eq('id', account.id)
      .select(ACCOUNT_SELECT)
      .single();

    updates.license = {
      attempted: true,
      success: !error,
      error: error?.message || null,
      repointed: Boolean(otherActive)
    };
  }

  // The legacy sites.quota_limit only falls back to the free allowance when no
  // other paid subscription still covers this site.
  const siteStillPaid = Boolean(otherActive && (!otherActive.site_id || otherActive.site_id === site?.id));
  if (site?.id && siteStillPaid) {
    updates.site = { attempted: false, skipped: 'other_active_subscription' };
  } else if (site?.id) {
    const { error } = await supabase
      .from('sites')
      .update({
        quota_limit: getLimits('free').credits,
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
    cancel_at_period_end: Boolean(subscription?.cancel_at_period_end)
  };
  // Never blank a stored billing period when the event carries none.
  if (subscription?.current_period_start) {
    updatePayload.current_period_start = subscription.current_period_start;
  }
  if (subscription?.current_period_end) {
    updatePayload.current_period_end = subscription.current_period_end;
  }

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
  idempotencyKey = null,
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
    stripeEventId: idempotencyKey || stripeEventId,
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
  stripeEventType,
  distinctId,
  distinctIdSource,
  account,
  site,
  eventProperties,
  metadata = {}
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

  logger.info('[billing] PostHog capture attempt', {
    stripeEventId,
    stripeEventType: eventProperties.stripe_event_type,
    distinctId
  });

  const canonicalResult = await emitCanonicalBillingEvents({
    stripeEventId,
    stripeEventType: stripeEventType || eventProperties.stripe_event_type,
    distinctId,
    eventProperties: {
      ...eventProperties,
      previous_plan: eventProperties.previous_plan || eventProperties.current_plan || account?.plan || null
    },
    metadata,
    site,
    account,
    includeLegacyPaymentSucceeded: true
  });

  const legacyCapture = canonicalResult.emitted.find((entry) => entry.event === 'payment_succeeded');
  if (legacyCapture?.ok) {
    logger.info('[billing] PostHog capture succeeded', {
      stripeEventId,
      stripeEventType: eventProperties.stripe_event_type,
      status: legacyCapture.status || null
    });
  } else if (legacyCapture && !legacyCapture.skipped) {
    logger.warn('[billing] PostHog capture failed', {
      stripeEventId,
      stripeEventType: eventProperties.stripe_event_type,
      status: legacyCapture.status || null
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
    return { sent: false, skipped: true };
  }

  try {
    await trackPlanUpgraded({
      email,
      planName: plan,
      purchaseType,
      billingPeriod: eventProperties.billing_period || 'unknown',
      amount: eventProperties.amount ?? null,
      currency: eventProperties.currency || null,
      stripeEventId
    });
  } catch (error) {
    logger.warn('[billing] Loops purchase event failed without failing Stripe webhook', {
      stripeEventId,
      purchaseType,
      plan,
      error: error.message
    });
    return { sent: false, error };
  }

  logger.info('[billing] Loops purchase event succeeded', {
    stripeEventId,
    purchaseType,
    plan
  });

  return { sent: true };
}

async function emitLoopsPaymentSucceeded({ stripeEventId, eventProperties }) {
  const email = eventProperties?.email || null;
  if (!email) {
    logger.info('[billing] Loops payment succeeded event skipped', {
      stripeEventId,
      emailPresent: false,
      plan: eventProperties?.plan || null
    });
    return { sent: false, skipped: true };
  }

  try {
    await trackPaymentSucceeded({
      email,
      planName: eventProperties.plan || null,
      purchaseType: eventProperties.purchase_type || 'unknown',
      billingPeriod: eventProperties.billing_period || 'unknown',
      amount: eventProperties.amount ?? null,
      currency: eventProperties.currency || null,
      checkoutSessionId: eventProperties.checkout_session_id || null,
      invoiceId: eventProperties.invoice_id || null,
      paymentLinkId: eventProperties.payment_link_id || null,
      stripeEventId
    });
  } catch (error) {
    logger.warn('[billing] Loops payment succeeded event failed without failing Stripe webhook', {
      stripeEventId,
      plan: eventProperties.plan || null,
      purchaseType: eventProperties.purchase_type || 'unknown',
      error: error.message
    });
    return { sent: false, error };
  }

  logger.info('[billing] Loops payment succeeded event sent', {
    stripeEventId,
    plan: eventProperties.plan || null,
    purchaseType: eventProperties.purchase_type || 'unknown'
  });

  return { sent: true };
}

function buildPaymentFailedEventProperties(paymentIntent = {}) {
  const charge = getExpandedLatestCharge(paymentIntent);
  const metadata = mergeStripeMetadata(paymentIntent.metadata, charge?.metadata);
  const failureCode = paymentIntent.last_payment_error?.code || null;
  const declineCode = paymentIntent.last_payment_error?.decline_code || null;
  const classification = classifyPaymentFailure({
    failureCode: failureCode || resolvePaymentFailureCode(paymentIntent),
    declineCode
  });
  const currency = normalizeCurrency(paymentIntent.currency);
  const amountMinor = paymentIntent.amount ?? paymentIntent.amount_capturable ?? null;

  return {
    email: resolvePaymentFailureEmail(paymentIntent, charge, metadata),
    plan: normalizePlanValue(
      extractMetadataValue(metadata, ['plan', 'plan_type', 'planType', 'target_plan', 'targetPlan'])
    ),
    amount: resolveAmount(amountMinor, currency),
    amount_minor: typeof amountMinor === 'number' ? amountMinor : null,
    currency,
    failure_code: failureCode,
    decline_code: declineCode,
    recoverability: classification.recoverability,
    suppression_reason: classification.suppressionReason,
    payment_intent_id: normalizeStripeId(paymentIntent),
    charge_id: normalizeStripeId(charge) || normalizeStripeId(paymentIntent.latest_charge),
    payment_link_id: normalizeStripeId(paymentIntent.payment_link)
      || normalizeStripeId(charge?.payment_link)
      || extractMetadataValue(metadata, ['payment_link_id', 'paymentLinkId']),
    checkout_session_id: extractMetadataValue(metadata, ['checkout_session_id', 'checkoutSessionId']),
    livemode: Boolean(paymentIntent.livemode)
  };
}

async function emitLoopsPaymentFailed({ stripeEventId, paymentIntent }) {
  const eventProperties = buildPaymentFailedEventProperties(paymentIntent);

  if (!eventProperties.email || eventProperties.recoverability !== 'recoverable') {
    logger.info('[billing] Loops payment failed event skipped', {
      stripeEventId,
      paymentIntentId: eventProperties.payment_intent_id || null,
      failureCode: eventProperties.failure_code || null,
      declineCode: eventProperties.decline_code || null,
      recoverability: eventProperties.recoverability,
      suppressionReason: eventProperties.suppression_reason,
      emailPresent: Boolean(eventProperties.email)
    });
    return {
      sent: false,
      eventProperties
    };
  }

  try {
    await trackPaymentFailed({
      email: eventProperties.email,
      planName: eventProperties.plan,
      amount: eventProperties.amount,
      currency: eventProperties.currency,
      failureCode: eventProperties.failure_code,
      declineCode: eventProperties.decline_code,
      recoverability: eventProperties.recoverability,
      paymentIntentId: eventProperties.payment_intent_id,
      chargeId: eventProperties.charge_id,
      paymentLinkId: eventProperties.payment_link_id,
      checkoutSessionId: eventProperties.checkout_session_id,
      stripeEventId
    });
  } catch (error) {
    logger.warn('[billing] Loops payment failed event failed without failing Stripe webhook', {
      stripeEventId,
      paymentIntentId: eventProperties.payment_intent_id,
      failureCode: eventProperties.failure_code,
      declineCode: eventProperties.decline_code,
      plan: eventProperties.plan,
      error: error.message
    });
    return {
      sent: false,
      error,
      eventProperties
    };
  }

  logger.info('[billing] Loops payment failed event succeeded', {
    stripeEventId,
    paymentIntentId: eventProperties.payment_intent_id,
    failureCode: eventProperties.failure_code,
    declineCode: eventProperties.decline_code,
    plan: eventProperties.plan
  });

  return {
    sent: true,
    eventProperties
  };
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
              stripeEventType: event.type,
              distinctId: payload.distinctId,
              distinctIdSource: payload.distinctIdSource,
              account: payload.account,
              site: payload.site,
              eventProperties: payload.eventProperties,
              metadata: session.metadata || {}
            });
            await emitLoopsPaymentSucceeded({
              stripeEventId: event.id,
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
            await emitCanonicalBillingEvents({
              stripeEventId: event.id,
              stripeEventType: event.type,
              distinctId: payload.distinctId,
              eventProperties: {
                ...payload.eventProperties,
                previous_plan: payload.eventProperties.current_plan || payload.account?.plan || 'free'
              },
              metadata: session.metadata || {},
              site: payload.site,
              account: payload.account,
              subscriptionStatus: 'active'
            });
          }
          logger.info('[billing] webhook_write_trace', billingTrace);
          break;
        }
        case 'invoice.payment_succeeded':
        case 'invoice.paid': {
          const invoice = event.data?.object;
          if (invoice) {
            const payload = await buildInvoiceSucceededPayload({
              supabase,
              stripeClient,
              invoice,
              priceIds,
              stripeEventType: event.type
            });
            // invoice.paid and invoice.payment_succeeded describe the same payment with
            // different event ids. Key side effects on the invoice so a pack is credited
            // once and Loops sends once even if the endpoint subscribes to both.
            const invoiceIdempotencyKey = invoice.id ? `invoice_paid:${invoice.id}` : event.id;
            const primaryLine = selectPrimaryInvoiceLine(invoice.lines?.data, payload.eventProperties.price_id);
            const firstLinePeriod = primaryLine?.period || null;
            const entitlementTrace = await reconcileSiteEntitlement({
              supabase,
              stripeEventId: event.id,
              idempotencyKey: invoiceIdempotencyKey,
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
            const invoiceMetadata = await resolveInvoiceMetadata(stripeClient, invoice);
            await emitPaymentSucceeded({
              stripeEventId: event.id,
              stripeEventType: event.type,
              distinctId: payload.distinctId,
              distinctIdSource: payload.distinctIdSource,
              account: payload.account,
              site: payload.site,
              eventProperties: payload.eventProperties,
              metadata: invoiceMetadata
            });
            await emitLoopsPaymentSucceeded({
              stripeEventId: invoiceIdempotencyKey,
              eventProperties: payload.eventProperties
            });
            await emitLoopsPurchaseSucceeded({
              stripeEventId: invoiceIdempotencyKey,
              eventProperties: payload.eventProperties
            });
          }
          logger.info('[billing] webhook_write_trace', billingTrace);
          break;
        }
        case 'payment_intent.payment_failed': {
          const paymentIntent = event.data?.object;
          if (paymentIntent) {
            const loopsTrace = await emitLoopsPaymentFailed({
              stripeEventId: event.id,
              paymentIntent
            });
            const failedProps = buildPaymentFailedEventProperties(paymentIntent);
            const metadata = mergeStripeMetadata(paymentIntent.metadata, getExpandedLatestCharge(paymentIntent)?.metadata);
            const identity = await resolveIdentityContext({
              supabase,
              metadata,
              email: failedProps.email,
              stripeCustomerId: normalizeStripeId(paymentIntent.customer),
              stripeSubscriptionId: null
            });
            const { distinctId } = resolveDistinctIdFromStripeEvent({
              account: identity.account,
              accountId: identity.accountId,
              userId: identity.userId,
              licenseKey: identity.licenseKey,
              site: identity.site,
              siteId: identity.siteId,
              siteHash: identity.siteHash,
              stripeCustomerId: normalizeStripeId(paymentIntent.customer),
              stripeSubscriptionId: null,
              email: identity.email,
              checkoutSessionId: failedProps.checkout_session_id,
              invoiceId: null
            });
            if (distinctId) {
              await emitPaymentFailedEvent({
                stripeEventId: event.id,
                distinctId,
                eventProperties: {
                  ...failedProps,
                  stripe_event_type: event.type,
                  stripe_customer_id: normalizeStripeId(paymentIntent.customer),
                  account_id: identity.account?.id || identity.accountId || null,
                  user_id: identity.userId || identity.account?.id || null,
                  site_id: identity.siteId,
                  site_hash: identity.siteHash,
                  license_key: identity.licenseKey,
                  license_key_present: Boolean(identity.licenseKey)
                },
                metadata,
                site: identity.site,
                account: identity.account
              });
            }
            billingTrace = {
              ...billingTrace,
              payment_intent_id: normalizeStripeId(paymentIntent),
              loops_payment_failed_sent: Boolean(loopsTrace.sent),
              loops_payment_failed_recoverability: loopsTrace.eventProperties?.recoverability || null,
              loops_payment_failed_suppression_reason: loopsTrace.eventProperties?.suppression_reason || null
            };
          }
          logger.info('[billing] webhook_write_trace', billingTrace);
          break;
        }
        case 'charge.refunded':
        case 'refund.created': {
          const refundObject = event.data?.object;
          const charge = refundObject?.charge && typeof refundObject.charge === 'object'
            ? refundObject.charge
            : null;
          const metadata = mergeStripeMetadata(refundObject?.metadata, charge?.metadata);
          const stripeCustomerId = normalizeStripeId(charge?.customer || refundObject?.customer);
          const identity = await resolveIdentityContext({
            supabase,
            metadata,
            email: null,
            stripeCustomerId,
            stripeSubscriptionId: null
          });
          const currency = normalizeCurrency(refundObject?.currency || charge?.currency);
          const amountMinor = refundObject?.amount ?? charge?.amount_refunded ?? null;
          const amount = resolveAmount(amountMinor, currency);
          const { distinctId } = resolveDistinctIdFromStripeEvent({
            account: identity.account,
            accountId: identity.accountId,
            userId: identity.userId,
            licenseKey: identity.licenseKey,
            site: identity.site,
            siteId: identity.siteId,
            siteHash: identity.siteHash,
            stripeCustomerId,
            stripeSubscriptionId: null,
            email: identity.email,
            checkoutSessionId: null,
            invoiceId: null
          });
          if (distinctId) {
            await emitCanonicalBillingEvents({
              stripeEventId: event.id,
              stripeEventType: event.type,
              distinctId,
              eventProperties: {
                source: 'stripe_webhook',
                stripe_event_type: event.type,
                amount,
                amount_minor: amountMinor,
                currency,
                plan: normalizePlanValue(extractMetadataValue(metadata, ['plan', 'target_plan'])) || identity.account?.plan || 'unknown',
                stripe_customer_id: stripeCustomerId,
                account_id: identity.account?.id || identity.accountId || null,
                user_id: identity.userId || identity.account?.id || null,
                site_id: identity.siteId,
                site_hash: identity.siteHash,
                license_key: identity.licenseKey,
                license_key_present: Boolean(identity.licenseKey)
              },
              metadata,
              site: identity.site,
              account: identity.account
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
            let entitlementTrace;
            try {
              entitlementTrace = await reconcileSubscriptionStatus({
                supabase,
                stripeEventId: event.id,
                account: payload.account,
                site: payload.site,
                eventProperties: payload.eventProperties,
                subscription: payload.subscription
              });
            } catch (error) {
              logger.warn('[billing] subscription status reconciliation failed without failing Stripe webhook', {
                stripeEventId: event.id,
                stripeEventType: event.type,
                stripeSubscriptionId: payload.eventProperties?.stripe_subscription_id || null,
                error: error.message
              });
              entitlementTrace = {
                subscriptions_written: false,
                licenses_updated: false,
                billing_info_source: 'site_subscriptions_failed',
                site_subscription_update_error: error.message
              };
            }
            billingTrace = {
              ...billingTrace,
              ...entitlementTrace,
              account_id: payload.account?.id || null,
              license_key_present: Boolean(payload.eventProperties.license_key),
              license_key_prefix: maskSecret(payload.eventProperties.license_key || null),
              site_id: payload.site?.id || null,
              site_hash: payload.site?.site_hash || payload.eventProperties.site_hash || null
            };
            const { distinctId } = resolveDistinctIdFromStripeEvent({
              account: payload.account,
              accountId: payload.eventProperties.account_id,
              userId: payload.eventProperties.user_id,
              licenseKey: payload.eventProperties.license_key,
              site: payload.site,
              siteId: payload.eventProperties.site_id,
              siteHash: payload.eventProperties.site_hash,
              stripeCustomerId: payload.eventProperties.stripe_customer_id,
              stripeSubscriptionId: payload.eventProperties.stripe_subscription_id,
              email: payload.eventProperties.email,
              checkoutSessionId: null,
              invoiceId: null
            });
            if (distinctId) {
              await emitCanonicalBillingEvents({
                stripeEventId: event.id,
                stripeEventType: event.type,
                distinctId,
                eventProperties: {
                  ...payload.eventProperties,
                  previous_plan: payload.account?.plan || 'free',
                  purchase_type: event.type === 'customer.subscription.deleted'
                    ? 'cancellation'
                    : inferPurchaseType({
                      eventType: event.type,
                      paymentMode: null,
                      stripeSubscriptionId: payload.eventProperties.stripe_subscription_id,
                      billingReason: 'subscription_update',
                      plan: payload.eventProperties.plan,
                      currentPlan: payload.account?.plan || 'free',
                      metadataPurchaseType: null
                    })
                },
                metadata: subscription.metadata || {},
                site: payload.site,
                account: payload.account,
                subscriptionStatus: payload.subscription?.status || subscription?.status || null
              });
            }
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

/**
 * One structured log line per /billing/checkout outcome. Never includes email,
 * license key (prefix only) or card data.
 */
function logCheckoutOutcome(context = {}, fields = {}) {
  const entry = {
    status: fields.status,
    outcome: fields.outcome,
    error_code: fields.error_code || null,
    country: context.country || null,
    country_source: context.countrySource || 'none',
    currency: context.currency || null,
    requested_price_id: context.requestedPriceId || null,
    price_id: fields.price_id !== undefined ? fields.price_id : (context.priceId || null),
    plan: fields.plan !== undefined ? fields.plan : (context.plan || null),
    mode: fields.mode || null,
    session_id: fields.session_id || null,
    idempotent_replayed: fields.idempotent_replayed === true,
    account_id: context.accountId || null,
    site_id: context.siteId || null,
    site_key: context.siteKey || null,
    license_key_prefix: context.licenseKeyPrefix || null,
    plugin_version: context.pluginVersion || null
  };
  if (fields.error_message) entry.error_message = String(fields.error_message).slice(0, 300);
  const level = fields.status >= 500 ? 'error' : fields.status >= 400 ? 'warn' : 'info';
  logger[level]('[billing] checkout_outcome', entry);
}

function isIdempotentReplay(session) {
  const headers = session?.lastResponse?.headers || {};
  const value = headers['idempotent-replayed'] ?? headers['Idempotent-Replayed'];
  return value === true || value === 'true';
}

function createBillingRouter({ supabase, requiredToken, getStripe, priceIds }) {
  const router = express.Router();

  const plans = buildPlansList(priceIds || {});

  router.get('/plans', async (req, res) => {
    const t0 = Date.now();
    try {
      // Currency from visitor geo country only (CF-IPCountry / plugin-forwarded), never locale.
      const country = resolveBillingCountry(req);
      const currency = resolveBillingCurrency(country);
      const catalogPriceIds = selectCatalogPriceIds(priceIds || {}, country);
      const payload = await getBillingPlansJsonLive(catalogPriceIds, getStripe, { currency });
      res.set('Cache-Control', 'public, max-age=300');
      res.set('Vary', 'CF-IPCountry, X-Visitor-Country, X-Client-Country, X-Admin-Country, X-Country');
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
    if (!hasAccountCredential(req)) return authRequired(res);
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

      return res.json({ success: true, data: { billing: redactStripeIds(billing) } });
    } catch (err) {
      logger.error('[billing] info error', err.message);
      return res.status(500).json({ success: false, error: 'Failed to fetch billing info', data: { error: err.message } });
    }
  });

  router.post('/checkout', async (req, res) => {
    const siteKey = req.header('X-Site-Key');
    const account = req.license || req.user || null;
    const { country: billingCountry, source: billingCountrySource } = resolveBillingCountryWithSource(req);
    const billingCurrency = resolveBillingCurrency(billingCountry);
    const requestedPriceId = typeof req.body?.priceId === 'string' ? req.body.priceId.trim() : (req.body?.priceId || null);
    const logContext = {
      country: billingCountry,
      countrySource: billingCountrySource,
      currency: billingCurrency,
      requestedPriceId,
      priceId: requestedPriceId,
      accountId: account?.id || null,
      siteKey: siteKey || null,
      licenseKeyPrefix: maskSecret(account?.license_key || null),
      pluginVersion: sanitizeStripeMetadataValue(req.body?.plugin_version, { maxLength: 32 }) || null
    };
    const reply = (status, body, fields = {}) => {
      logCheckoutOutcome(logContext, { status, ...fields });
      return res.status(status).json(body);
    };

    if (requiredToken) {
      const token = req.header('Authorization')?.replace(/^Bearer\s+/i, '') || req.header('X-API-Key');
      if (token !== requiredToken) {
        return reply(401, { error: 'Unauthorized' }, { outcome: 'unauthorized', error_code: 'UNAUTHORIZED' });
      }
    }
    if (!siteKey) {
      return reply(400, { error: 'Missing X-Site-Key header', code: 'MISSING_SITE_KEY' }, {
        outcome: 'rejected', error_code: 'MISSING_SITE_KEY'
      });
    }
    const { successUrl, cancelUrl } = req.body || {};
    let priceId = requestedPriceId;
    const catalogPriceIds = selectCatalogPriceIds(priceIds || {}, billingCountry);
    const requestedAttribution = normalizeCheckoutAttribution(req.body);
    const allowedPriceIds = listConfiguredPriceIds(priceIds || {});

    if (!priceId || !allowedPriceIds.includes(priceId)) {
      return reply(400, {
        error: 'Invalid or missing priceId',
        code: 'INVALID_PRICE_ID',
        message: 'This plan is not available for checkout. Please refresh the page and try again.',
        valid: priceIds
      }, { outcome: 'rejected', error_code: 'INVALID_PRICE_ID' });
    }

    // USD Price IDs are US-only. For any other (or unknown) country, fall back to
    // the same plan's GBP price rather than dead-ending the customer with a 400.
    let currencyFallback = null;
    if (isUsdPriceId(priceIds, priceId) && billingCurrency !== 'usd') {
      const gbpPriceId = findGbpEquivalentPriceId(priceIds, priceId);
      if (!gbpPriceId) {
        return reply(400, {
          error: 'USD priceId requires US visitor country',
          code: 'USD_PRICE_REQUIRES_US_COUNTRY',
          message: 'This price is only available in the United States, and no local-currency price is configured for this plan.',
          country: billingCountry,
          currency: billingCurrency
        }, { outcome: 'rejected', error_code: 'USD_PRICE_REQUIRES_US_COUNTRY' });
      }
      currencyFallback = { from: priceId, to: gbpPriceId };
      priceId = gbpPriceId;
      logContext.priceId = priceId;
    }
    // The currency we report is the one the chosen Price charges in. The
    // country-derived currency only picks between twins, so a GBP price on a
    // request whose country resolved to US must not be echoed as 'usd'.
    const chargeCurrency = isUsdPriceId(priceIds, priceId) ? 'usd' : 'gbp';
    logContext.currency = chargeCurrency;
    if (chargeCurrency !== billingCurrency) {
      logContext.countryCurrency = billingCurrency;
    }
    const selectedPlan = plans.find((plan) => plan.priceId === priceId)
      || buildPlansList(catalogPriceIds, { currency: billingCurrency }).find((plan) => plan.priceId === priceId)
      || null;

    // Without an account credential, any checkout for a licence that already
    // has a subscription gets the sign-in reply: before site resolution (no
    // writes) and before any Stripe call.
    if (supabase && account && !hasAccountCredential(req)) {
      let existing;
      try {
        existing = await selectBillingSiteSubscriptionForLicense(supabase, account);
      } catch (error) {
        return reply(500, {
          error: 'Failed to create checkout session',
          code: 'CHECKOUT_SESSION_FAILED',
          message: 'Stripe could not start checkout right now. Please try again in a minute.'
        }, { outcome: 'error', error_code: 'SUBSCRIPTION_LOOKUP_FAILED', error_message: error?.message });
      }
      if (existing.subscription) {
        return reply(401, SIGN_IN_REQUIRED_BODY, { outcome: 'rejected', error_code: 'SIGN_IN_REQUIRED' });
      }
    }

    let siteRecord = null;
    let metadataSiteKey = siteKey;
    if (supabase && siteKey) {
      const siteIdentity = buildSiteIdentity({
        siteHash: siteKey,
        installUuid: siteKey,
        siteUrl: req.header('X-Site-URL') || null,
        siteFingerprint: req.header('X-Site-Fingerprint') || null
      });
      try {
        // Look the site up without attaching the caller, and only run the full
        // resolve (create, membership, owner healing) for a new site or one the
        // caller's account owns.
        const probe = await resolveCanonicalSite(supabase, siteIdentity, {
          createIfMissing: false,
          legacyLicenseKey: account?.license_key || null,
          account: null
        });
        const resolved = !probe.site || !account || siteOwnedByAccount(probe.site, account)
          ? await resolveCanonicalSite(supabase, siteIdentity, {
            createIfMissing: true,
            legacyLicenseKey: account?.license_key || null,
            account
          })
          : probe;
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
      if (siteRecord && account && !siteOwnedByAccount(siteRecord, account)) {
        logger.warn('[billing] checkout site not owned', {
          account_id: account.id || null,
          site_hash: maskSecret(siteKey)
        });
        siteRecord = null;
        metadataSiteKey = null;
      }
    }

    logContext.siteId = siteRecord?.id || null;

    const stripeClient = getStripe();
    if (!stripeClient) {
      return reply(501, { error: 'Stripe not configured', code: 'STRIPE_NOT_CONFIGURED' }, {
        outcome: 'error', error_code: 'STRIPE_NOT_CONFIGURED'
      });
    }
    try {
      // Resolve from allowlisted priceId first so USD IDs (absent from the GBP
      // plans catalog) still map to starter/pro/agency/credits. No second plans grid.
      const selectedPlanId = normalizePlanValue(
        resolvePlanFromPriceId(priceIds, priceId) || selectedPlan?.id || null
      );
      const currentPlan = normalizePlanValue(account?.plan || null);
      const planForCheckout = plans.find((plan) => plan.id === selectedPlanId) || selectedPlan || null;
      const mode = selectedPlanId === 'credits' || planForCheckout?.interval === 'one-time'
        ? 'payment'
        : 'subscription';
      logContext.plan = selectedPlanId;
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
        return reply(429, {
          error: 'CHECKOUT_RATE_LIMIT_EXCEEDED',
          code: 'CHECKOUT_RATE_LIMIT_EXCEEDED',
          message: 'Too many checkout attempts. Please wait a few minutes before trying again.',
          retry_after: checkoutRateLimit.retryAfterSeconds
        }, { outcome: 'rate_limited', error_code: 'CHECKOUT_RATE_LIMIT_EXCEEDED', mode });
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
            return reply(409, {
              success: false,
              error: 'ACTIVE_SUBSCRIPTION_EXISTS',
              code: 'ACTIVE_SUBSCRIPTION_EXISTS',
              message: 'An active subscription already exists for this license.'
            }, { outcome: 'rejected', error_code: 'ACTIVE_SUBSCRIPTION_EXISTS', mode });
          }

          const portalSession = await stripeClient.billingPortal.sessions.create({
            customer: existingCustomerId,
            return_url: cancelUrl || successUrl || `${process.env.FRONTEND_URL || 'https://oppti.dev'}/billing`
          });
          logger.info('[billing] active subscription checkout redirected to portal', {
            account_id: account?.id || null,
            licenseKeyPrefix: maskSecret(account?.license_key || null),
            site_id: existingSubscription.site_id || siteRecord?.id || null,
            stripeCustomerId: existingCustomerId,
            stripeSubscriptionId: existingSubscription.stripe_subscription_id || null,
            billing_info_source: existingBilling.resolutionPath
          });
          return reply(200, {
            success: true,
            url: portalSession.url,
            portal: true,
            customerId: maskStripeId(existingCustomerId),
            subscriptionId: maskStripeId(existingSubscription.stripe_subscription_id || null)
          }, { outcome: 'portal_redirect', mode });
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
        return reply(403, {
          error: 'SITE_LIMIT_EXCEEDED',
          code: 'SITE_LIMIT_EXCEEDED',
          message: 'This subscription plan is limited to 1 site per subscription.',
          plan: selectedPlanId
        }, { outcome: 'rejected', error_code: 'SITE_LIMIT_EXCEEDED', mode });
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
      // Identity metadata comes from the signed-in account and the X-Site-Key
      // site. Body identity fields are only used when there is no account
      // (server-to-server calls with the API token).
      const bodyIdentity = account ? {} : requestedAttribution;
      const checkoutMetadata = {
        account_id: sanitizeStripeMetadataValue(account?.id) || bodyIdentity.accountId,
        license_key: sanitizeStripeMetadataValue(account?.license_key)
          || sanitizeStripeMetadataValue(siteRecord?.license_key)
          || bodyIdentity.licenseKey,
        site_id: sanitizeStripeMetadataValue(siteRecord?.id) || bodyIdentity.siteId,
        site_hash: sanitizeStripeMetadataValue(siteRecord?.site_hash)
          || sanitizeStripeMetadataValue(metadataSiteKey)
          || bodyIdentity.siteHash,
        site_install_id: sanitizeStripeMetadataValue(siteRecord?.site_hash)
          || sanitizeStripeMetadataValue(metadataSiteKey)
          || bodyIdentity.siteInstallId,
        user_id: sanitizeStripeMetadataValue(req.user?.id)
          || sanitizeStripeMetadataValue(account?.id)
          || bodyIdentity.userId,
        email: sanitizeStripeMetadataValue(account?.email, { lowercase: true }) || bodyIdentity.email,
        plan: selectedPlanId || undefined,
        current_plan: currentPlan || undefined,
        billing_interval: resolveCheckoutBillingInterval(planForCheckout, selectedPlanId),
        purchase_type: purchaseType !== 'unknown' ? purchaseType : undefined,
        trigger_feature: requestedAttribution.triggerFeature,
        trigger_location: requestedAttribution.triggerLocation,
        source_page: requestedAttribution.sourcePage,
        target_plan: selectedPlanId || requestedAttribution.targetPlan || undefined,
        source: 'app',
        utm_source: requestedAttribution.utmSource,
        utm_medium: requestedAttribution.utmMedium,
        utm_campaign: requestedAttribution.utmCampaign,
        utm_content: requestedAttribution.utmContent,
        utm_term: requestedAttribution.utmTerm,
        referrer: requestedAttribution.referrer,
        landing_page: requestedAttribution.landingPage,
        acquisition_channel: requestedAttribution.acquisitionChannel,
        plugin_version: requestedAttribution.pluginVersion,
        country: requestedAttribution.country
      };
      const metadata = Object.fromEntries(
        Object.entries(checkoutMetadata).filter(([, value]) => value !== undefined && value !== null && value !== '')
      );
      const checkoutPayload = {
        mode,
        line_items: [{ price: priceId, quantity: 1 }],
        success_url: successUrl || `${process.env.FRONTEND_URL || 'https://oppti.dev'}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: cancelUrl || `${process.env.FRONTEND_URL || 'https://oppti.dev'}/billing/cancel`,
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
        attemptId: mode === 'payment' && selectedPlanId === 'credits' ? crypto.randomUUID() : null,
        checkoutParams: checkoutPayload
      });
      const session = await stripeClient.checkout.sessions.create(checkoutPayload, { idempotencyKey });
      // Same params within Stripe's 24h idempotency window return the existing
      // open session instead of a new one; that is a success, not a failure.
      const reused = isIdempotentReplay(session);
      const responseBody = {
        success: true,
        url: session.url,
        // sessionId kept for existing clients; session_id/checkout_url are aliases.
        sessionId: session.id,
        session_id: session.id,
        checkout_url: session.url,
        reused,
        currency: normalizeCurrency(session.currency) || chargeCurrency
      };
      if (currencyFallback) {
        responseBody.currency_fallback = { requested_price_id: currencyFallback.from, price_id: currencyFallback.to, currency: 'gbp' };
      }
      return reply(200, responseBody, {
        outcome: currencyFallback ? 'session_created_gbp_fallback' : (reused ? 'session_reused' : 'session_created'),
        mode,
        session_id: session.id,
        idempotent_replayed: reused
      });
    } catch (error) {
      const stripeCode = error?.code || error?.raw?.code || error?.type || null;
      return reply(500, {
        error: 'Failed to create checkout session',
        code: 'CHECKOUT_SESSION_FAILED',
        message: 'Stripe could not start checkout right now. Please try again in a minute.'
      }, {
        outcome: 'error',
        error_code: stripeCode ? `STRIPE_${String(stripeCode).toUpperCase()}` : 'CHECKOUT_SESSION_FAILED',
        error_message: error?.message
      });
    }
  });

  /**
   * POST /billing/checkout/email-link
   * Emails the link to the caller's own open Checkout Session to the email on
   * file for the authenticated account. Never accepts a recipient address; the
   * session must belong to the account (client_reference_id / metadata.account_id).
   */
  router.post('/checkout/email-link', async (req, res) => {
    const account = req.license || req.user || null;
    const sessionId = typeof req.body?.session_id === 'string' ? req.body.session_id.trim()
      : (typeof req.body?.sessionId === 'string' ? req.body.sessionId.trim() : '');
    const logBase = { account_id: account?.id || null, session_id: sessionId || null };
    const reply = (status, body, outcome, errorCode = null) => {
      const level = status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info';
      logger[level]('[billing] checkout_link_email', { ...logBase, status, outcome, error_code: errorCode });
      return res.status(status).json(body);
    };

    if (requiredToken) {
      const token = req.header('Authorization')?.replace(/^Bearer\s+/i, '') || req.header('X-API-Key');
      if (token !== requiredToken) {
        return reply(401, { error: 'Unauthorized', code: 'UNAUTHORIZED' }, 'unauthorized', 'UNAUTHORIZED');
      }
    }
    const accountEmail = normalizeEmail(account?.email);
    if (!account?.id || !accountEmail) {
      return reply(401, {
        error: 'AUTH_REQUIRED',
        code: 'AUTH_REQUIRED',
        message: 'Please sign in to your account to email yourself the payment link.'
      }, 'rejected', 'AUTH_REQUIRED');
    }
    if (req.body && (req.body.to || req.body.email || req.body.recipient)) {
      return reply(400, {
        error: 'RECIPIENT_NOT_ALLOWED',
        code: 'RECIPIENT_NOT_ALLOWED',
        message: 'The link can only be sent to the email address on your account.'
      }, 'rejected', 'RECIPIENT_NOT_ALLOWED');
    }
    if (!/^cs_(live|test)_[A-Za-z0-9]+$/.test(sessionId)) {
      return reply(400, {
        error: 'INVALID_SESSION_ID',
        code: 'INVALID_SESSION_ID',
        message: 'This checkout link is not valid. Please start checkout again.'
      }, 'rejected', 'INVALID_SESSION_ID');
    }

    const now = Date.now();
    pruneCheckoutRateBuckets(now);
    const bucketKey = ['checkout-email', account.id].join(':');
    const hits = checkoutRateBuckets.get(bucketKey) || [];
    if (hits.length >= CHECKOUT_LINK_EMAIL_LIMIT) {
      return reply(429, {
        error: 'CHECKOUT_LINK_EMAIL_RATE_LIMITED',
        code: 'CHECKOUT_LINK_EMAIL_RATE_LIMITED',
        message: 'We have already emailed this link a few times. Please check your inbox (and spam folder).',
        retry_after: Math.ceil(CHECKOUT_RATE_LIMIT_WINDOW_MS / 1000)
      }, 'rate_limited', 'CHECKOUT_LINK_EMAIL_RATE_LIMITED');
    }

    const stripeClient = getStripe();
    if (!stripeClient?.checkout?.sessions?.retrieve) {
      return reply(501, { error: 'Stripe not configured', code: 'STRIPE_NOT_CONFIGURED' }, 'error', 'STRIPE_NOT_CONFIGURED');
    }
    if (!emailService.isAvailable()) {
      return reply(503, {
        error: 'EMAIL_UNAVAILABLE',
        code: 'EMAIL_UNAVAILABLE',
        message: 'Email is unavailable right now. Please copy the link instead.'
      }, 'error', 'EMAIL_UNAVAILABLE');
    }

    let session;
    try {
      session = await stripeClient.checkout.sessions.retrieve(sessionId);
    } catch (error) {
      return reply(404, {
        error: 'SESSION_NOT_FOUND',
        code: 'SESSION_NOT_FOUND',
        message: 'This checkout link has expired. Please start checkout again.'
      }, 'rejected', 'SESSION_NOT_FOUND');
    }
    const ownerId = session?.client_reference_id || session?.metadata?.account_id || null;
    if (!session || String(ownerId) !== String(account.id)) {
      return reply(403, {
        error: 'SESSION_NOT_OWNED',
        code: 'SESSION_NOT_OWNED',
        message: 'This checkout link belongs to a different account.'
      }, 'rejected', 'SESSION_NOT_OWNED');
    }
    if (session.status !== 'open' || !session.url) {
      return reply(410, {
        error: 'SESSION_NOT_OPEN',
        code: 'SESSION_NOT_OPEN',
        message: session.status === 'complete'
          ? 'This checkout is already complete.'
          : 'This checkout link has expired. Please start checkout again.'
      }, 'rejected', 'SESSION_NOT_OPEN');
    }

    hits.push(now);
    checkoutRateBuckets.set(bucketKey, hits);
    const planKey = normalizePlanValue(session.metadata?.plan || null);
    const planLabel = planKey === 'pro' ? 'the Growth plan'
      : planKey === 'starter' ? 'the Starter plan'
        : planKey === 'agency' ? 'the Agency plan'
          : planKey === 'credits' ? 'your credit pack' : 'your plan';
    const result = await emailService.sendCheckoutLinkEmail({ to: accountEmail, checkoutUrl: session.url, planLabel });
    if (!result.success) {
      return reply(502, {
        error: 'EMAIL_SEND_FAILED',
        code: 'EMAIL_SEND_FAILED',
        message: 'We could not send the email. Please copy the link instead.'
      }, 'error', 'EMAIL_SEND_FAILED');
    }
    // Only a signed-in account or licence holder sees which address was used.
    return reply(200, hasAccountCredential(req)
      ? { success: true, sent_to: accountEmail.replace(/^(.{2}).*(@.*)$/, '$1***$2') }
      : { success: true }, 'sent');
  });

  router.post('/portal', async (req, res) => {
    if (!hasAccountCredential(req)) return authRequired(res);
    if (!requireBillingAuth(req, res)) return;
    const { returnUrl } = req.body || {};
    const requestedCustomerId = typeof req.body?.customerId === 'string' ? req.body.customerId.trim() : '';
    const account = req.license || req.user || null;
    const stripeClient = getStripe();
    if (!stripeClient) {
      return res.status(501).json({ error: 'Stripe not configured' });
    }

    // The customer always comes from the caller's own account.
    let resolvedCustomerId = account.stripe_customer_id || null;
    let resolvedSubscriptionId = account.stripe_subscription_id || null;
    let resolutionSource = resolvedCustomerId ? 'account' : 'unresolved';

    if (!resolvedCustomerId && supabase) {
      const resolved = await selectBillingSiteSubscriptionForLicense(supabase, account);
      if (resolved.subscription?.stripe_customer_id) {
        resolvedCustomerId = resolved.subscription.stripe_customer_id;
        resolvedSubscriptionId = resolved.subscription.stripe_subscription_id || resolvedSubscriptionId;
        resolutionSource = `site_subscriptions:${resolved.resolutionPath}`;
      }
    }

    if (requestedCustomerId && requestedCustomerId !== resolvedCustomerId) {
      const owned = await isCustomerOwnedByAccount(supabase, account, requestedCustomerId);
      if (!owned) {
        logger.warn('[billing] portal customer mismatch', {
          account_id: account.id || null,
          licenseKeyPrefix: maskSecret(account.license_key || null)
        });
        return res.status(403).json({
          error: 'This billing account does not belong to you.',
          code: 'CUSTOMER_NOT_OWNED'
        });
      }
      resolvedCustomerId = requestedCustomerId;
      resolutionSource = 'request_owned';
    }

    if (!resolvedCustomerId) {
      logger.warn('[billing] portal customer unresolved', {
        account_id: account.id || null,
        licenseKeyPrefix: maskSecret(account.license_key || null),
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
        return_url: returnUrl || `${process.env.FRONTEND_URL || 'https://oppti.dev'}/billing`
      });
      res.json({
        success: true,
        url: session.url,
        customerId: maskStripeId(resolvedCustomerId),
        subscriptionId: maskStripeId(resolvedSubscriptionId),
        source: resolutionSource
      });
    } catch (error) {
      logger.error('[billing] portal error', error.message);
      res.status(500).json({ error: 'Failed to create portal session' });
    }
  });

  router.get('/subscription', async (req, res) => {
    if (!hasAccountCredential(req)) return authRequired(res);
    if (!requireBillingAuth(req, res)) return;
    const siteKey = req.header('X-Site-Key');
    const freePlan = { plan: 'free', status: 'free', billingCycle: null, nextBillingDate: null, subscriptionId: null, cancelAtPeriodEnd: false };
    const account = req.user || req.license || null;
    try {
      if (!supabase) return res.json({ success: true, data: freePlan });

      const licenseKey = req.license?.license_key || account.license_key || null;
      const siteIdentity = buildSiteIdentity({
        siteHash: siteKey,
        installUuid: siteKey,
        siteUrl: req.header('X-Site-URL') || null,
        siteFingerprint: req.header('X-Site-Fingerprint') || null
      });
      const resolveOptions = {
        legacyLicenseKey: licenseKey,
        requestId: req.id || null
      };

      // Look the site up first without attaching the caller to it, then run the
      // full resolve (membership and owner healing) only for the caller's own site.
      const probe = await resolveCanonicalSite(supabase, siteIdentity, {
        ...resolveOptions,
        createIfMissing: false,
        account: null
      });
      let resolved = probe;
      if (!probe.site || siteOwnedByAccount(probe.site, account)) {
        resolved = await resolveCanonicalSite(supabase, siteIdentity, {
          ...resolveOptions,
          createIfMissing: true,
          account
        });
      }

      if (resolved.error && resolved.error !== 'SITE_NOT_FOUND') {
        logger.error('[site] billing_subscription_site_healing_failed', {
          request_id: req.id || null,
          account_id: account.id || null,
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

      if (effectiveSite && !siteOwnedByAccount(effectiveSite, account)) {
        logger.warn('[billing] subscription_site_not_held', {
          request_id: req.id || null,
          account_id: account.id || null,
          site_hash: maskSecret(siteKey || null)
        });
        return res.json({ success: true, data: await planFromLicense(licenseKey, null) || freePlan });
      }

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
            subscriptionId: maskStripeId(siteSubscription.stripe_subscription_id || null),
            cancelAtPeriodEnd: siteSubscription.cancel_at_period_end || false
          }
        });
      }

      res.json({ success: true, data: await planFromLicense(effectiveSite.license_key, effectiveSite) });
    } catch (error) {
      logger.error('[billing] subscription fetch error', error.message);
      res.status(500).json({ error: 'Failed to fetch subscription' });
    }
  });

  async function planFromLicense(licenseKey, site) {
    const { data: license } = licenseKey
      ? await supabase
        .from('licenses')
        .select('plan, status, billing_cycle, stripe_subscription_id')
        .eq('license_key', licenseKey)
        .maybeSingle()
      : { data: null };

    if (site) {
      logger.info('[billing] subscription_source_resolved', {
        source: 'licenses',
        site_id: site.id,
        site_hash: site.site_hash || null,
        stripe_subscription_id: license?.stripe_subscription_id || null
      });
    }
    if (!license && !site) return null;

    return {
      plan: license?.plan || 'free',
      status: license?.status || 'active',
      billingCycle: license?.billing_cycle || 'month',
      nextBillingDate: null,
      subscriptionId: maskStripeId(license?.stripe_subscription_id || null),
      cancelAtPeriodEnd: false
    };
  }

  return router;
}

module.exports = {
  createBillingRouter,
  createBillingWebhookHandler
};
