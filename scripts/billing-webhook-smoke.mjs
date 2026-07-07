#!/usr/bin/env node
/**
 * Signed Stripe webhook smoke against a live billing endpoint.
 *
 * Usage:
 *   STRIPE_SECRET_KEY=sk_test_... \
 *   STRIPE_WEBHOOK_SECRET=whsec_... \
 *   BILLING_WEBHOOK_URL=https://alttext-ai-backend.onrender.com/billing/webhook \
 *   node scripts/billing-webhook-smoke.mjs payment_recovered
 */
import crypto from 'node:crypto';

const WEBHOOK_URL = (process.env.BILLING_WEBHOOK_URL || 'https://alttext-ai-backend.onrender.com/billing/webhook').replace(/\/$/, '');
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';

const SCENARIOS = {
  payment_recovered: {
    id: `evt_smoke_payment_recovered_${Date.now()}`,
    type: 'invoice.payment_succeeded',
    data: {
      object: {
        id: `in_smoke_recovered_${Date.now()}`,
        amount_paid: 1499,
        currency: 'usd',
        customer: 'cus_smoke_recovered',
        subscription: 'sub_smoke_recovered',
        billing_reason: 'subscription_cycle',
        attempt_count: 2,
        livemode: false,
        metadata: {
          plan: 'pro',
          license_key: 'smoke-license-recovered',
          account_id: 'smoke-account-recovered'
        },
        lines: {
          data: [{ price: { id: 'price_pro', product: 'prod_pro', recurring: { interval: 'month' } } }]
        }
      }
    }
  },
  payment_failed: {
    id: `evt_smoke_payment_failed_${Date.now()}`,
    type: 'payment_intent.payment_failed',
    data: {
      object: {
        id: `pi_smoke_failed_${Date.now()}`,
        amount: 999,
        currency: 'gbp',
        customer: 'cus_smoke_failed',
        livemode: false,
        metadata: { plan: 'pro', license_key: 'smoke-license-failed' },
        last_payment_error: {
          code: 'card_declined',
          decline_code: 'insufficient_funds'
        }
      }
    }
  }
};

function signStripePayload(payload, secret) {
  const timestamp = Math.floor(Date.now() / 1000);
  const body = JSON.stringify(payload);
  const signedPayload = `${timestamp}.${body}`;
  const signature = crypto
    .createHmac('sha256', secret)
    .update(signedPayload, 'utf8')
    .digest('hex');
  return {
    body,
    header: `t=${timestamp},v1=${signature}`
  };
}

async function main() {
  const scenarioName = process.argv[2] || 'payment_recovered';
  const scenario = SCENARIOS[scenarioName];

  if (!scenario) {
    console.error(`Unknown scenario: ${scenarioName}. Available: ${Object.keys(SCENARIOS).join(', ')}`);
    process.exit(1);
  }

  if (!WEBHOOK_SECRET) {
    console.error('Missing STRIPE_WEBHOOK_SECRET — cannot sign live webhook payload.');
    process.exit(2);
  }

  if (!STRIPE_SECRET_KEY) {
    console.warn('STRIPE_WEBHOOK_SECRET set but STRIPE_SECRET_KEY missing — Render may still accept signed test events.');
  }

  const event = {
    id: scenario.id,
    object: 'event',
    type: scenario.type,
    livemode: false,
    created: Math.floor(Date.now() / 1000),
    data: scenario.data
  };

  const { body, header } = signStripePayload(event, WEBHOOK_SECRET);
  const response = await fetch(WEBHOOK_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Stripe-Signature': header
    },
    body
  });

  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }

  console.log(JSON.stringify({
    scenario: scenarioName,
    eventId: event.id,
    eventType: event.type,
    url: WEBHOOK_URL,
    status: response.status,
    body: parsed
  }, null, 2));

  if (!response.ok) {
    process.exit(3);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
