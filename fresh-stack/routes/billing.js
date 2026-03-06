const express = require('express');
const logger = require('../lib/logger');

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

  router.get('/plans', (_req, res) => {
    res.json({ success: true, plans });
  });

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
        plan = license.plan || license.plan_type || 'free';
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
    if (priceId === priceIds.pro && supabase) {
      try {
        const { data: subs } = await supabase
          .from('subscriptions')
          .select('id')
          .eq('site_hash', siteKey)
          .eq('plan', 'pro')
          .in('status', ['active', 'trial', 'past_due']);
        if (subs && subs.length > 0) {
          return res.status(403).json({
            error: 'SITE_LIMIT_EXCEEDED',
            message: 'Pro plan is limited to 1 site per subscription.',
            plan: 'pro'
          });
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
    try {
      const { data: subscription } = supabase
        ? await supabase.from('subscriptions').select('*').eq('site_hash', siteKey).single()
        : { data: null };
      if (!subscription) {
        return res.json({
          success: true,
          data: {
            plan: 'free',
            status: 'free',
            billingCycle: null,
            nextBillingDate: null,
            subscriptionId: null,
            cancelAtPeriodEnd: false
          }
        });
      }
      res.json({
        success: true,
        data: {
          plan: subscription.plan || 'free',
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

module.exports = { createBillingRouter };
