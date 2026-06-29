const logger = require('../../fresh-stack/lib/logger');

const LOOPS_API_KEY = process.env.LOOPS_API_KEY;
const LOOPS_BASE = 'https://app.loops.so/api/v1';
const PLUGIN_USERS_LIST_ID = 'cmn7g83oddsuu0izg27ia6tgv';
const LOOPS_TIMEOUT_MS = Number(process.env.LOOPS_TIMEOUT_MS || 5000);

async function loopsRequest(method, path, body, { idempotencyKey = null } = {}) {
  if (!LOOPS_API_KEY) {
    logger.info('[signup] Loops request skipped', {
      path,
      method,
      reason: 'LOOPS_API_KEY missing'
    });
    return null;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LOOPS_TIMEOUT_MS);

  try {
    const headers = {
      'Authorization': `Bearer ${LOOPS_API_KEY}`,
      'Content-Type': 'application/json',
    };
    if (idempotencyKey) {
      headers['Idempotency-Key'] = String(idempotencyKey).slice(0, 100);
    }

    const res = await fetch(`${LOOPS_BASE}${path}`, {
      method,
      headers,
      signal: controller.signal,
      body: JSON.stringify(body),
    });

    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      const error = new Error(`Loops ${method} ${path} failed with status ${res.status}`);
      error.status = res.status;
      error.payload = payload;
      throw error;
    }

    logger.info('[signup] Loops request succeeded', {
      path,
      method,
      status: res.status
    });
    return payload;
  } catch (err) {
    logger.error('[signup] Loops request failed', {
      path,
      method,
      error: err.message,
      status: err.status || null
    });
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

async function loopsPost(path, body) {
  await loopsRequest('POST', path, body);
}

async function trackAccountCreated({ email, firstName, isWooCommerce, imagesUnprocessed }) {
  const mailingLists = { [PLUGIN_USERS_LIST_ID]: true };
  const created = await loopsRequest('POST', '/contacts/create', {
    email, firstName: firstName || '', userGroup: 'plugin_user', source: 'plugin_signup', mailingLists,
  });
  // If contact already existed (409), contacts/create won't apply mailingLists — update to ensure list membership
  if (created && !created.id && created.message?.toLowerCase().includes('already')) {
    await loopsRequest('PUT', '/contacts/update', { email, mailingLists });
  }
  await loopsPost('/events/send', {
    email,
    eventName: 'account_created',
    eventProperties: {
      plan: 'free',
      generationsCount: 0,
      imagesUnprocessed: imagesUnprocessed || 0,
      woocommerce: isWooCommerce || false
    }
  });
}

async function trackGenerationMilestone({ email, generationsCount, imagesUnprocessed }) {
  const count = Number(generationsCount) || 0;
  if (count !== 1 && count % 5 !== 0) return;
  await loopsPost('/events/send', {
    email,
    eventName: 'generation_completed',
    eventProperties: {
      generationsCount: count,
      imagesUnprocessed,
      lastGenerationAt: new Date().toISOString()
    }
  });
}

async function trackCreditsExhausted({ email, imagesUnprocessed }) {
  await loopsPost('/events/send', {
    email,
    eventName: 'credits_exhausted',
    eventProperties: {
      imagesUnprocessed,
      plan: 'free'
    }
  });
}

async function trackPlanUpgraded({
  email,
  planName,
  purchaseType = 'new_purchase',
  billingPeriod = 'unknown',
  amount = null,
  currency = null,
  stripeEventId = null
}) {
  await loopsRequest('PUT', '/contacts/update', { email, plan: planName });
  await loopsRequest('POST', '/events/send', {
    email,
    eventName: 'plan_upgraded',
    eventProperties: {
      plan: planName,
      purchaseType,
      billingPeriod,
      amount,
      currency,
      stripeEventId
    }
  }, { idempotencyKey: stripeEventId });
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
    lastSuccessfulPaymentAt: succeededAt,
    lastSuccessfulPaymentPlan: planName || '',
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

module.exports = {
  trackAccountCreated,
  trackGenerationMilestone,
  trackCreditsExhausted,
  trackPlanUpgraded,
  trackPaymentFailed,
  trackPaymentSucceeded
};
