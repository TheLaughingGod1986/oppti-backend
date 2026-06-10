let stripeClient = null;

function getStripe() {
  if (stripeClient) return stripeClient;
  const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeSecretKey) return null;
  // Lazy load stripe to avoid dependency issues in tests
  // eslint-disable-next-line global-require
  const Stripe = require('stripe');
  stripeClient = new Stripe(stripeSecretKey, { apiVersion: '2022-11-15' });
  return stripeClient;
}

async function createCheckoutSession({ priceId, successUrl, cancelUrl, customerEmail, metadata }) {
  const stripe = getStripe();
  if (!stripe) throw new Error('Stripe not configured');
  return stripe.checkout.sessions.create({
    mode: 'subscription',
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: successUrl,
    cancel_url: cancelUrl,
    customer_email: customerEmail,
    metadata
  });
}

async function createPortalSession({ customerId, returnUrl }) {
  const stripe = getStripe();
  if (!stripe) throw new Error('Stripe not configured');
  return stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: returnUrl
  });
}

function verifyWebhookSignature({ payload, signature, secret }) {
  const stripe = getStripe();
  if (!stripe) throw new Error('Stripe not configured');
  return stripe.webhooks.constructEvent(payload, signature, secret);
}

module.exports = {
  getStripe,
  createCheckoutSession,
  createPortalSession,
  verifyWebhookSignature
};
