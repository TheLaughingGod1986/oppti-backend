const crypto = require('crypto');
const logger = require('../../fresh-stack/lib/logger');
const { getPlugin, normalizePluginId, LOOPS_SOURCE_BY_PLUGIN } = require('./pluginIdentity');

const LOOPS_BASE = 'https://app.loops.so/api/v1';
const LOOPS_TIMEOUT_MS = Number(process.env.LOOPS_TIMEOUT_MS || 5000);
// QA/test account email domains that must never reach Loops.
// LOOPS_SKIP_DOMAINS (comma-separated) replaces this default when set, even to ''.
const DEFAULT_LOOPS_SKIP_DOMAINS = 'example.invalid,maxxspace.com,uberip.com,qa.oppti.dev';

function getApiKey() {
  return process.env.LOOPS_API_KEY || '';
}

function getPluginUsersListId() {
  const listId = process.env.LOOPS_PLUGIN_USERS_LIST_ID || '';
  if (listId && !/^[a-z0-9]+$/i.test(listId)) {
    throw new Error('LOOPS_PLUGIN_USERS_LIST_ID must be a Loops mailing list ID');
  }
  return listId;
}

function getSkipDomains() {
  const raw = process.env.LOOPS_SKIP_DOMAINS === undefined
    ? DEFAULT_LOOPS_SKIP_DOMAINS
    : String(process.env.LOOPS_SKIP_DOMAINS);
  return raw
    .split(',')
    .map((domain) => domain.trim().toLowerCase())
    .filter(Boolean);
}

function getEmailDomain(email) {
  if (!email || typeof email !== 'string') return null;
  const at = email.lastIndexOf('@');
  if (at < 0) return null;
  const domain = email.slice(at + 1).trim().toLowerCase();
  return domain || null;
}

function isLoopsSkippedEmail(email) {
  const domain = getEmailDomain(email);
  if (!domain) return false;
  return getSkipDomains().includes(domain);
}

function logSkippedEmail(email, context = {}) {
  logger.info('[loops] Request skipped', {
    ...context,
    reason: 'LOOPS_SKIP_DOMAINS',
    email_domain: getEmailDomain(email)
  });
}

function buildIdempotencyKey(...parts) {
  const input = parts.filter((part) => part !== null && part !== undefined).join(':');
  return `bbai-${crypto.createHash('sha256').update(input).digest('hex')}`;
}

async function loopsRequest(method, path, body, { idempotencyKey = null } = {}) {
  const apiKey = getApiKey();
  if (!apiKey) {
    logger.info('[loops] Request skipped', {
      path,
      method,
      reason: 'LOOPS_API_KEY missing'
    });
    return null;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LOOPS_TIMEOUT_MS);
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json'
  };
  if (idempotencyKey) {
    headers['Idempotency-Key'] = String(idempotencyKey).slice(0, 100);
  }

  try {
    const res = await fetch(`${LOOPS_BASE}${path}`, {
      method,
      headers,
      signal: controller.signal,
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      const error = new Error(`Loops ${method} ${path} failed with status ${res.status}`);
      error.status = res.status;
      error.payload = payload;
      throw error;
    }
    logger.info('[loops] Request succeeded', { path, method, status: res.status });
    return payload;
  } catch (error) {
    logger.error('[loops] Request failed', {
      path,
      method,
      error: error.message,
      status: error.status || null
    });
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function loopsPost(path, body, options = {}) {
  return loopsRequest('POST', path, body, options);
}

function pluginContactProperties(pluginId, pluginVersion, timestamp, { includeFirstSeen = false } = {}) {
  const plugin = getPlugin(pluginId);
  const prefix = {
    alt_text: 'altText',
    titles: 'titles',
    internal_linking: 'internalLinking'
  }[plugin.id];
  const flag = {
    alt_text: 'usesAltText',
    titles: 'usesTitles',
    internal_linking: 'usesInternalLinking'
  }[plugin.id];
  return {
    lastActivePluginId: plugin.id,
    lastActivePluginTitle: plugin.title,
    lastPluginSeenAt: timestamp,
    [flag]: true,
    [`${prefix}PluginVersion`]: pluginVersion || '',
    [`${prefix}LastActiveAt`]: timestamp,
    ...(includeFirstSeen ? { [`${prefix}FirstSeenAt`]: timestamp } : {})
  };
}

function mailingListsPayload() {
  const listId = getPluginUsersListId();
  return listId ? { mailingLists: { [listId]: true } } : {};
}

// Loops /contacts/update overwrites every field it is sent, so an existing
// contact's `source` (e.g. an audit or newsletter lead) would be lost if we
// always sent the plugin source on account creation. Only set `source` when
// we positively know the contact is new or has an empty source; if the lookup
// fails or is ambiguous, leave it out so we never overwrite by default.
async function shouldSetContactSource(email) {
  try {
    const contacts = await loopsRequest('GET', `/contacts/find?email=${encodeURIComponent(email)}`);
    if (!Array.isArray(contacts)) {
      logger.warn('[loops] Contact lookup returned no usable result; leaving source unchanged', {
        email_domain: getEmailDomain(email)
      });
      return false;
    }
    if (contacts.length === 0) return true;
    const existingSource = contacts[0] && contacts[0].source;
    return !(typeof existingSource === 'string' && existingSource.trim() !== '');
  } catch (error) {
    logger.warn('[loops] Contact lookup failed; leaving source unchanged', {
      email_domain: getEmailDomain(email),
      error: error.message,
      status: error.status || null
    });
    return false;
  }
}

async function upsertPluginContact({
  email,
  userId,
  firstName = '',
  pluginId,
  pluginVersion,
  acquisition = false,
  timestamp = new Date().toISOString(),
  extra = {}
}) {
  if (isLoopsSkippedEmail(email)) {
    logSkippedEmail(email, { path: '/contacts/update', method: 'PUT' });
    return null;
  }
  const plugin = getPlugin(pluginId);
  const properties = pluginContactProperties(plugin.id, pluginVersion, timestamp, {
    includeFirstSeen: acquisition
  });
  const setSource = acquisition === true && await shouldSetContactSource(email);
  const payload = {
    email,
    ...(userId ? { userId: String(userId) } : {}),
    ...(firstName ? { firstName } : {}),
    ...mailingListsPayload(),
    ...properties,
    ...(acquisition === true ? {
      ...(setSource ? { source: LOOPS_SOURCE_BY_PLUGIN[plugin.id] } : {}),
      signupPlugin: plugin.id,
      userGroup: 'free',
      acquisitionPluginId: plugin.id,
      acquisitionPluginTitle: plugin.title,
      firstPluginSeenAt: timestamp
    } : {}),
    ...extra
  };
  await loopsRequest('PUT', '/contacts/update', payload);
  return payload;
}

async function sendEvent(eventName, {
  email,
  userId,
  pluginId,
  pluginVersion,
  idempotencyParts = [],
  ...eventProperties
}) {
  if (isLoopsSkippedEmail(email)) {
    logSkippedEmail(email, { path: '/events/send', method: 'POST', event_name: eventName });
    return null;
  }
  const plugin = getPlugin(pluginId);
  const identity = userId || email;
  return loopsRequest('POST', '/events/send', {
    email,
    ...(userId ? { userId: String(userId) } : {}),
    eventName,
    eventProperties: {
      pluginId: plugin.id,
      pluginTitle: plugin.title,
      pluginVersion: pluginVersion || '',
      ...eventProperties
    }
  }, {
    idempotencyKey: buildIdempotencyKey(identity, eventName, plugin.id, ...idempotencyParts)
  });
}

async function trackAccountCreated({
  email,
  userId,
  firstName,
  pluginId = 'alt_text',
  pluginVersion,
  isWooCommerce,
  imagesUnprocessed
}) {
  const timestamp = new Date().toISOString();
  const normalizedPluginId = normalizePluginId(pluginId);
  await upsertPluginContact({
    email,
    userId,
    firstName,
    pluginId: normalizedPluginId,
    pluginVersion,
    acquisition: true,
    timestamp,
    extra: {
      plan: 'free',
      generationsCount: 0,
      imagesUnprocessed: imagesUnprocessed || 0,
      woocommerce: Boolean(isWooCommerce)
    }
  });
  await sendEvent('account_created', {
    email,
    userId,
    pluginId: normalizedPluginId,
    pluginVersion,
    idempotencyParts: ['created'],
    plan: 'free',
    generationsCount: 0,
    imagesUnprocessed: imagesUnprocessed || 0,
    woocommerce: Boolean(isWooCommerce)
  });
  await sendEvent('plugin_connected', {
    email,
    userId,
    pluginId: normalizedPluginId,
    pluginVersion,
    idempotencyParts: ['connected']
  });
}

async function trackPluginConnected({ email, userId, pluginId, pluginVersion, emitEvent = true }) {
  const timestamp = new Date().toISOString();
  await upsertPluginContact({ email, userId, pluginId, pluginVersion, timestamp });
  if (emitEvent) {
    await sendEvent('plugin_connected', {
      email,
      userId,
      pluginId,
      pluginVersion,
      idempotencyParts: ['connected']
    });
  }
}

async function trackGenerationMilestone({
  email,
  userId,
  pluginId,
  pluginVersion,
  generationsCount,
  imagesUnprocessed
}) {
  if (generationsCount <= 0 || generationsCount % 5 !== 0) return;
  const timestamp = new Date().toISOString();
  await upsertPluginContact({
    email,
    userId,
    pluginId,
    pluginVersion,
    timestamp,
    extra: { generationsCount }
  });
  await sendEvent('generation_completed', {
    email,
    userId,
    pluginId,
    pluginVersion,
    idempotencyParts: [generationsCount],
    generationsCount,
    imagesUnprocessed: imagesUnprocessed || 0,
    lastGenerationAt: timestamp
  });
}

async function trackCreditsExhausted({
  email,
  userId,
  pluginId,
  pluginVersion,
  imagesUnprocessed,
  periodStart
}) {
  await sendEvent('credits_exhausted', {
    email,
    userId,
    pluginId,
    pluginVersion,
    idempotencyParts: [periodStart || 'current'],
    imagesUnprocessed: imagesUnprocessed || 0,
    plan: 'free'
  });
}

async function trackPlanUpgraded({
  email,
  userId,
  planName,
  pluginId = 'alt_text',
  pluginVersion,
  purchaseType = 'new_purchase',
  billingPeriod = 'unknown',
  amount = null,
  currency = null,
  stripeEventId = null
}) {
  await loopsRequest('PUT', '/contacts/update', {
    email,
    ...(userId ? { userId: String(userId) } : {}),
    plan: planName,
    // Subscription updates can report a downgrade to free; only mark real paid plans.
    ...(planName && String(planName).toLowerCase() !== 'free' ? { userGroup: 'paid' } : {})
  });
  await sendEvent('plan_upgraded', {
    email,
    userId,
    pluginId,
    pluginVersion,
    idempotencyParts: [stripeEventId || planName],
    plan: planName,
    purchaseType,
    billingPeriod,
    amount,
    currency,
    stripeEventId
  });
}

async function trackPaymentFailed({
  email,
  planName = null,
  amount = null,
  currency = null,
  failureCode = null,
  declineCode = null,
  recoverability = 'recoverable',
  paymentIntentId = null,
  chargeId = null,
  paymentLinkId = null,
  checkoutSessionId = null,
  stripeEventId = null
}) {
  const failedAt = new Date().toISOString();
  await loopsRequest('PUT', '/contacts/update', {
    email,
    lastPaymentFailureAt: failedAt,
    lastPaymentFailurePlan: planName || '',
    lastPaymentFailureCode: failureCode || declineCode || '',
    lastPaymentFailureRecoverability: recoverability
  });
  await loopsRequest('POST', '/events/send', {
    email,
    eventName: 'payment_failed',
    eventProperties: {
      plan: planName,
      amount,
      currency,
      failureCode,
      declineCode,
      recoverability,
      lastPaymentFailureRecoverability: recoverability,
      paymentIntentId,
      chargeId,
      paymentLinkId,
      checkoutSessionId,
      stripeEventId
    }
  }, { idempotencyKey: stripeEventId });
}

async function trackPaymentSucceeded({
  email,
  planName = null,
  purchaseType = 'unknown',
  billingPeriod = 'unknown',
  amount = null,
  currency = null,
  checkoutSessionId = null,
  invoiceId = null,
  paymentLinkId = null,
  stripeEventId = null
}) {
  const succeededAt = new Date().toISOString();
  await loopsRequest('PUT', '/contacts/update', {
    email,
    plan: planName || '',
    userGroup: 'paid',
    lastSuccessfulPaymentAt: succeededAt,
    lastSuccessfulPaymentPlan: planName || '',
    lastSuccessfulPaymentPurchaseType: purchaseType || '',
    lastPaymentFailureRecoverability: ''
  });
  await loopsRequest('POST', '/events/send', {
    email,
    eventName: 'payment_succeeded',
    eventProperties: {
      plan: planName,
      purchaseType,
      billingPeriod,
      amount,
      currency,
      checkoutSessionId,
      invoiceId,
      paymentLinkId,
      stripeEventId
    }
  }, { idempotencyKey: stripeEventId });
}

async function trackImageSeoAuditRequested({
  email,
  websiteUrl,
  normalizedDomain,
  auditId,
  source = 'image-seo-audit'
}) {
  await upsertAuditLeadContact({ email, websiteUrl, normalizedDomain, source });
  await loopsPost('/events/send', {
    email,
    eventName: 'image_seo_audit_requested',
    eventProperties: {
      auditId,
      websiteUrl,
      normalizedDomain,
      source
    }
  });
}

async function trackImageSeoAuditCompleted({
  email,
  websiteUrl,
  normalizedDomain,
  auditId,
  auditScore,
  pagesScanned,
  imagesScanned,
  missingAltPercent,
  source = 'image-seo-audit'
}) {
  await upsertAuditLeadContact({
    email,
    websiteUrl,
    normalizedDomain,
    source,
    auditScore,
    pagesScanned,
    imagesScanned,
    missingAltPercent
  });
  await loopsPost('/events/send', {
    email,
    eventName: 'image_seo_audit_completed',
    eventProperties: {
      auditId,
      websiteUrl,
      normalizedDomain,
      auditScore,
      pagesScanned,
      imagesScanned,
      missingAltPercent,
      source
    }
  });
}

async function trackImageSeoAuditFailed({
  email,
  websiteUrl,
  normalizedDomain,
  auditId,
  errorCode,
  source = 'image-seo-audit'
}) {
  await upsertAuditLeadContact({ email, websiteUrl, normalizedDomain, source });
  await loopsPost('/events/send', {
    email,
    eventName: 'image_seo_audit_failed',
    eventProperties: {
      auditId,
      websiteUrl,
      normalizedDomain,
      errorCode,
      source
    }
  });
}

async function upsertAuditLeadContact({
  email,
  websiteUrl,
  normalizedDomain,
  source,
  auditScore = null,
  pagesScanned = null,
  imagesScanned = null,
  missingAltPercent = null
}) {
  const body = {
    email,
    websiteUrl,
    normalizedDomain
  };
  if (auditScore !== null) body.auditScore = auditScore;
  if (pagesScanned !== null) body.pagesScanned = pagesScanned;
  if (imagesScanned !== null) body.imagesScanned = imagesScanned;
  if (missingAltPercent !== null) body.missingAltPercent = missingAltPercent;

  try {
    await loopsRequest('POST', '/contacts/create', {
      ...body,
      userGroup: 'lead',
      source,
      subscribed: true
    });
  } catch (error) {
    if (error.status !== 409) {
      throw error;
    }
    await loopsRequest('PUT', '/contacts/update', body);
  }
}

module.exports = {
  buildIdempotencyKey,
  getSkipDomains,
  isLoopsSkippedEmail,
  pluginContactProperties,
  sendEvent,
  trackAccountCreated,
  trackCreditsExhausted,
  trackGenerationMilestone,
  trackImageSeoAuditCompleted,
  trackImageSeoAuditFailed,
  trackImageSeoAuditRequested,
  trackPaymentFailed,
  trackPaymentSucceeded,
  trackPlanUpgraded,
  trackPluginConnected,
  upsertPluginContact
};
