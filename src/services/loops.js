const LOOPS_API_KEY = process.env.LOOPS_API_KEY;
const LOOPS_BASE = 'https://app.loops.so/api/v1';

async function loopsPost(path, body) {
  if (!LOOPS_API_KEY) return;
  try {
    await fetch(`${LOOPS_BASE}${path}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${LOOPS_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    console.error('[Loops]', err.message);
  }
}

async function trackAccountCreated({ email, firstName, isWooCommerce, imagesUnprocessed }) {
  await loopsPost('/contacts/create', { email, firstName: firstName || '', userGroup: 'plugin_user', source: 'plugin_signup' });
  await loopsPost('/events/send', { email, eventName: 'account_created', plan: 'free', generationsCount: 0, imagesUnprocessed: imagesUnprocessed || 0, woocommerce: isWooCommerce || false });
}

async function trackGenerationMilestone({ email, generationsCount, imagesUnprocessed }) {
  if (generationsCount % 5 !== 0) return;
  await loopsPost('/events/send', { email, eventName: 'generation_completed', generationsCount, imagesUnprocessed, lastGenerationAt: new Date().toISOString() });
}

async function trackCreditsExhausted({ email, imagesUnprocessed }) {
  await loopsPost('/events/send', { email, eventName: 'credits_exhausted', imagesUnprocessed, plan: 'free' });
}

async function trackPlanUpgraded({ email, planName }) {
  await loopsPost('/contacts/update', { email, plan: planName });
  await loopsPost('/events/send', { email, eventName: 'plan_upgraded', plan: planName });
}

module.exports = { trackAccountCreated, trackGenerationMilestone, trackCreditsExhausted, trackPlanUpgraded };
