const express = require('express');
const logger = require('../lib/logger');
const { verifyWebhookSignature } = require('../lib/stripe');
const { captureServerEvent, identifyServerUser } = require('../lib/posthog');

const ZERO_DECIMAL_CURRENCIES = new Set([
  'bif', 'clp', 'djf', 'gnf', 'jpy', 'kmf', 'krw', 'mga', 'pyg',
  'rwf', 'ugx', 'vnd', 'vuv', 'xaf', 'xof', 'xpf'
]);

function resolvePlanFromPriceId(priceIds = {}, priceId) {
  if (!priceId) return null;
  const match = Object.entries(priceIds).find(([, configuredPriceId]) => configuredPriceId === priceId);
  return match ? match[0] : null;
}

function resolveAmount(amountMinor, currency) {
  if (typeof amountMinor !== 'number') return null;
  const normalizedCurrency = typeof currency === 'string' ? currency.toLowerCase() : '';
  if (ZERO_DECIMAL_CURRENCIES.has(normalizedCurrency)) {
    return amountMinor;
  }
  return amountMinor / 100;
}

function extractMetadataValue(metadata = {}, keys = []) {
  for (const key of keys) {
    if (typeof metadata[key] === 'string' && metadata[key]) {
      return metadata[key];
    }
  }
  return null;
}

async function findAccountByEmail(supabase, email) {
  if (!supabase || !email) return null;

  // `licenses` is the canonical account table in this backend.
  const { data, error } = await supabase
    .from('licenses')
    .select('id, email, license_key, stripe_customer_id')
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

async function findAccountByStripeCustomerId(supabase, stripeCustomerId) {
  if (!supabase || !stripeCustomerId) return null;

  const { data, error } = await supabase
    .from('licenses')
    .select('id, email, license_key, stripe_customer_id')
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

async function persistStripeCustomerId(supabase, account, stripeCustomerId) {
  if (!supabase || !account?.id || !stripeCustomerId) {
    return account || null;
  }

  if (account.stripe_customer_id === stripeCustomerId) {
    return account;
  }

  const { data, error } = await supabase
    .from('licenses')
    .update({ stripe_customer_id: stripeCustomerId })
    .eq('id', account.id)
    .select('id, email, license_key, stripe_customer_id')
    .single();

  if (error) {
    logger.warn('[billing] failed to persist stripe customer id', {
      accountId: account.id,
      stripeCustomerId,
      error: error.message
    });
    return {
      ...account,
      stripe_customer_id: stripeCustomerId
    };
  }

  return data || {
    ...account,
    stripe_customer_id: stripeCustomerId
  };
}

async function loadCheckoutLineItemContext(stripeClient, sessionId, priceIds) {
  if (!stripeClient || !sessionId) {
    return { priceId: null, productId: null, plan: null };
  }

  try {
    const lineItems = await stripeClient.checkout.sessions.listLineItems(sessionId, { limit: 1 });
    const firstLineItem = Array.isArray(lineItems?.data) ? lineItems.data[0] : null;
    const priceId = firstLineItem?.price?.id || null;
    const rawProduct = firstLineItem?.price?.product;
    const productId = typeof rawProduct === 'string' ? rawProduct : rawProduct?.id || null;

    return {
      priceId,
      productId,
      plan: resolvePlanFromPriceId(priceIds, priceId)
    };
  } catch (error) {
    logger.warn('[billing] webhook line item lookup failed', {
      sessionId,
      error: error.message
    });
    return { priceId: null, productId: null, plan: null };
  }
}

async function resolveCheckoutIdentity({ supabase, session }) {
  const metadata = session.metadata || {};
  const email = session.customer_details?.email || session.customer_email || extractMetadataValue(metadata, ['email']);
  const stripeCustomerId = typeof session.customer === 'string' ? session.customer : session.customer?.id || null;

  let account = await findAccountByEmail(supabase, email);
  if (!account && email) {
    logger.warn('[billing] account not found for checkout email', { email });
  }

  if (account && stripeCustomerId) {
    account = await persistStripeCustomerId(supabase, account, stripeCustomerId);
  }

  return {
    account,
    email,
    stripeCustomerId
  };
}

async function resolveInvoiceIdentity({ supabase, invoice }) {
  const metadata = invoice.metadata || {};
  const stripeCustomerId = typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id || null;
  const fallbackEmail = invoice.customer_email || extractMetadataValue(metadata, ['email']);

  let account = await findAccountByStripeCustomerId(supabase, stripeCustomerId);
  if (!account && fallbackEmail) {
    account = await findAccountByEmail(supabase, fallbackEmail);
    if (account && stripeCustomerId) {
      account = await persistStripeCustomerId(supabase, account, stripeCustomerId);
    }
  }

  if (!account && stripeCustomerId) {
    logger.warn('[billing] account not found for invoice customer', {
      stripeCustomerId,
      email: fallbackEmail || null
    });
  }

  return {
    account,
    email: account?.email || fallbackEmail || null,
    stripeCustomerId
  };
}

async function buildCheckoutSucceededPayload({ supabase, stripeClient, session, priceIds }) {
  const metadata = session.metadata || {};
  const context = await loadCheckoutLineItemContext(stripeClient, session.id, priceIds);
  const identity = await resolveCheckoutIdentity({ supabase, session });
  const stripeCustomerId = identity.stripeCustomerId;
  const stripeSubscriptionId = typeof session.subscription === 'string' ? session.subscription : session.subscription?.id || null;
  const siteId = extractMetadataValue(metadata, ['site_id', 'siteId', 'site_hash', 'siteHash']);
  const licenseKey = extractMetadataValue(metadata, ['license_key', 'licenseKey']) || identity.account?.license_key || null;

  return {
    distinctId: identity.account?.id || stripeCustomerId || stripeSubscriptionId || session.id,
    account: identity.account,
    eventProperties: {
      source: 'stripe_webhook',
      stripe_event_type: 'checkout.session.completed',
      amount: resolveAmount(session.amount_total, session.currency),
      amount_minor: session.amount_total ?? null,
      currency: session.currency || null,
      plan: extractMetadataValue(metadata, ['plan', 'plan_type', 'planType']) || context.plan,
      price_id: context.priceId,
      product_id: context.productId,
      stripe_customer_id: stripeCustomerId,
      stripe_subscription_id: stripeSubscriptionId,
      checkout_session_id: session.id,
      invoice_id: typeof session.invoice === 'string' ? session.invoice : session.invoice?.id || null,
      payment_link_id: typeof session.payment_link === 'string' ? session.payment_link : session.payment_link?.id || null,
      site_id: siteId,
      email: identity.email,
      user_id: identity.account?.id || null,
      license_key: licenseKey,
      license_key_present: Boolean(licenseKey),
      livemode: Boolean(session.livemode),
      payment_mode: session.mode || null,
      billing_reason: null
    }
  };
}

async function buildInvoiceSucceededPayload({ supabase, invoice, priceIds }) {
  const metadata = invoice.metadata || {};
  const identity = await resolveInvoiceIdentity({ supabase, invoice });
  const firstLineItem = Array.isArray(invoice.lines?.data) ? invoice.lines.data[0] : null;
  const priceId = firstLineItem?.price?.id || null;
  const rawProduct = firstLineItem?.price?.product;
  const productId = typeof rawProduct === 'string' ? rawProduct : rawProduct?.id || null;
  const stripeCustomerId = identity.stripeCustomerId;
  const stripeSubscriptionId = typeof invoice.subscription === 'string' ? invoice.subscription : invoice.subscription?.id || null;
  const siteId = extractMetadataValue(metadata, ['site_id', 'siteId', 'site_hash', 'siteHash']);
  const licenseKey = extractMetadataValue(metadata, ['license_key', 'licenseKey']) || identity.account?.license_key || null;

  return {
    distinctId: identity.account?.id || stripeCustomerId || stripeSubscriptionId || invoice.id,
    account: identity.account,
    eventProperties: {
      source: 'stripe_webhook',
      stripe_event_type: 'invoice.payment_succeeded',
      amount: resolveAmount(invoice.amount_paid, invoice.currency),
      amount_minor: invoice.amount_paid ?? null,
      currency: invoice.currency || null,
      plan: extractMetadataValue(metadata, ['plan', 'plan_type', 'planType']) || resolvePlanFromPriceId(priceIds, priceId),
      price_id: priceId,
      product_id: productId,
      stripe_customer_id: stripeCustomerId,
      stripe_subscription_id: stripeSubscriptionId,
      checkout_session_id: null,
      invoice_id: invoice.id,
      payment_link_id: null,
      site_id: siteId,
      email: identity.email,
      user_id: identity.account?.id || null,
      license_key: licenseKey,
      license_key_present: Boolean(licenseKey),
      livemode: Boolean(invoice.livemode),
      payment_mode: null,
      billing_reason: invoice.billing_reason || null
    }
  };
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
      license_key: account.license_key || null
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

async function emitPaymentSucceeded({ stripeEventId, distinctId, account, eventProperties }) {
  if (!distinctId) {
    logger.warn('[billing] webhook payment_succeeded skipped: no distinct id', {
      stripeEventId,
      stripeEventType: eventProperties.stripe_event_type
    });
    return;
  }

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
            await emitPaymentSucceeded({
              stripeEventId: event.id,
              distinctId: payload.distinctId,
              account: payload.account,
              eventProperties: payload.eventProperties
            });
          }
          break;
        }
        case 'invoice.payment_succeeded': {
          const invoice = event.data?.object;
          if (invoice) {
            const payload = await buildInvoiceSucceededPayload({
              supabase,
              invoice,
              priceIds
            });
            await emitPaymentSucceeded({
              stripeEventId: event.id,
              distinctId: payload.distinctId,
              account: payload.account,
              eventProperties: payload.eventProperties
            });
          }
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
    }

    return res.status(200).json({ received: true });
  };
}

function createBillingRouter({ supabase, requiredToken, getStripe, priceIds }) {
  const router = express.Router();

  const plans = [
    {
      id: 'pro',
      name: 'Pro Plan',
      price: 14.99,
      currency: 'usd',
      interval: 'month',
      quota: 1000,
      sites: 1,
      features: [
        '1,000 AI-generated alt texts per month',
        'WCAG-compliant descriptions',
        'Bulk generate for media library',
        'Priority email support',
        'Use on one WordPress site'
      ],
      priceId: priceIds.pro,
      trialDays: 0,
      scope: 'site'
    },
    {
      id: 'agency',
      name: 'Agency Plan',
      price: 59.99,
      currency: 'usd',
      interval: 'month',
      quota: 10000,
      sites: 'unlimited',
      features: [
        '10,000 AI-generated alt texts per month',
        'WCAG 2.1 AA for all client sites',
        'Bulk generate across multiple sites',
        'Dedicated account manager and priority support',
        'Use on unlimited WordPress sites'
      ],
      priceId: priceIds.agency,
      trialDays: 0,
      scope: 'shared'
    },
    {
      id: 'credits',
      name: 'Credit Pack',
      price: 11.99,
      currency: 'usd',
      interval: 'one-time',
      quota: 100,
      sites: 'any',
      features: [
        '100 credits for alt text generation',
        'Credits never expire',
        'No subscription required',
        'Use on any WordPress site'
      ],
      priceId: priceIds.credits,
      trialDays: 0,
      scope: 'site'
    }
  ];

  const PLANS_CACHE_TTL_MS = 5 * 60 * 1000;
  let plansCache = null;
  let plansCacheExpiry = 0;

  router.get('/plans', (_req, res) => {
    const now = Date.now();
    if (plansCache && plansCacheExpiry > now) {
      return res.json(plansCache);
    }
    const payload = { success: true, plans };
    plansCache = payload;
    plansCacheExpiry = now + PLANS_CACHE_TTL_MS;
    res.json(payload);
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
      let plan = 'free';
      let status = 'free';
      let billingCycle = null;
      let nextBillingDate = null;
      let subscriptionId = null;
      let cancelAtPeriodEnd = false;
      let customerId = null;

      if (license) {
        plan = license.plan || 'free';
        status = license.status || 'active';
        customerId = license.stripe_customer_id || null;
        subscriptionId = license.stripe_subscription_id || null;
        billingCycle = license.billing_cycle || 'monthly';
        if (license.billing_anchor_date) {
          const anchor = new Date(license.billing_anchor_date);
          const next = new Date(anchor);
          next.setUTCMonth(next.getUTCMonth() + 1);
          nextBillingDate = next.toISOString();
        }
      }

      if (supabase && subscriptionId) {
        const { data: sub } = await supabase.from('subscriptions').select('plan, status, current_period_end, cancel_at_period_end').eq('stripe_subscription_id', subscriptionId).maybeSingle();
        if (sub) {
          plan = sub.plan || plan;
          status = sub.status || status;
          nextBillingDate = sub.current_period_end || nextBillingDate;
          cancelAtPeriodEnd = sub.cancel_at_period_end || false;
        }
      }

      const billing = {
        plan,
        status,
        billingCycle,
        nextBillingDate,
        subscriptionId,
        cancelAtPeriodEnd,
        customerId
      };
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

    if (!priceId || !Object.values(priceIds).includes(priceId)) {
      return res.status(400).json({ error: 'Invalid or missing priceId', valid: priceIds });
    }
    // Enforce site limit for PRO: only 1 site per subscription
    // Look up via sites → licenses rather than relying on a site_hash column that doesn't exist on subscriptions
    if (priceId === priceIds.pro && supabase) {
      try {
        const { data: siteRecord } = await supabase
          .from('sites')
          .select('license_key')
          .eq('site_hash', siteKey)
          .eq('status', 'active')
          .maybeSingle();
        if (siteRecord?.license_key) {
          const { data: existingLicense } = await supabase
            .from('licenses')
            .select('plan')
            .eq('license_key', siteRecord.license_key)
            .single();
          if (existingLicense?.plan === 'pro') {
            return res.status(403).json({
              error: 'SITE_LIMIT_EXCEEDED',
              message: 'Pro plan is limited to 1 site per subscription.',
              plan: 'pro'
            });
          }
        }
      } catch (e) {
        // fail-open
      }
    }

    const stripeClient = getStripe();
    if (!stripeClient) {
      return res.status(501).json({ error: 'Stripe not configured' });
    }
    try {
      const session = await stripeClient.checkout.sessions.create({
        mode: 'subscription',
        line_items: [{ price: priceId, quantity: 1 }],
        success_url: successUrl || `${process.env.FRONTEND_URL || 'https://example.com'}/billing/success`,
        cancel_url: cancelUrl || `${process.env.FRONTEND_URL || 'https://example.com'}/billing/cancel`,
        metadata: { site_id: siteKey }
      });
      res.json({ success: true, url: session.url, sessionId: session.id });
    } catch (error) {
      logger.error('[billing] checkout error', error.message);
      res.status(500).json({ error: 'Failed to create checkout session' });
    }
  });

  router.post('/portal', async (req, res) => {
    if (!requireBillingAuth(req, res)) return;
    const { returnUrl, customerId } = req.body || {};
    const stripeClient = getStripe();
    if (!stripeClient) {
      return res.status(501).json({ error: 'Stripe not configured' });
    }
    if (!customerId) {
      return res.status(400).json({ error: 'customerId is required for portal' });
    }
    try {
      const session = await stripeClient.billingPortal.sessions.create({
        customer: customerId,
        return_url: returnUrl || `${process.env.FRONTEND_URL || 'https://example.com'}/billing`
      });
      res.json({ success: true, url: session.url });
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

      // Resolve license via site hash, then look up stripe_subscription_id on the license
      const { data: siteRecord } = await supabase
        .from('sites')
        .select('license_key')
        .eq('site_hash', siteKey)
        .eq('status', 'active')
        .maybeSingle();

      if (!siteRecord?.license_key) return res.json({ success: true, data: freePlan });

      const { data: license } = await supabase
        .from('licenses')
        .select('plan, stripe_subscription_id')
        .eq('license_key', siteRecord.license_key)
        .single();

      if (!license?.stripe_subscription_id) {
        return res.json({ success: true, data: { ...freePlan, plan: license?.plan || 'free' } });
      }

      const { data: subscription } = await supabase
        .from('subscriptions')
        .select('plan, status, current_period_end, cancel_at_period_end, stripe_subscription_id')
        .eq('stripe_subscription_id', license.stripe_subscription_id)
        .maybeSingle();

      if (!subscription) {
        return res.json({ success: true, data: { ...freePlan, plan: license.plan || 'free' } });
      }

      res.json({
        success: true,
        data: {
          plan: subscription.plan || license.plan || 'free',
          status: subscription.status || 'active',
          billingCycle: 'month',
          nextBillingDate: subscription.current_period_end || null,
          subscriptionId: subscription.stripe_subscription_id || null,
          cancelAtPeriodEnd: subscription.cancel_at_period_end || false
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
