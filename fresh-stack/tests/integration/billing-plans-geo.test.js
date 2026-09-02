const express = require('express');
const request = require('supertest');

const { createBillingRouter } = require('../../routes/billing');
const { invalidateBillingPlansCache, invalidateLiveBillingPlansCache } = require('../../services/billingPlansCatalog');

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/billing', createBillingRouter({
    supabase: null,
    getStripe: () => null,
    priceIds: {
      starter: 'price_gbp_starter',
      pro: 'price_gbp_pro',
      agency: 'price_gbp_agency',
      credits: 'price_gbp_credits',
      starterUsd: 'price_1UBBZlJl9Rm418cMyqCUYrxp',
      proUsd: 'price_1UBBOuJl9Rm418cMz5HG1Lnu',
      agencyUsd: 'price_1UBBSDJl9Rm418cMvzW2OxG9',
      creditsUsd: 'price_1UBBVeJl9Rm418cM1k7PC7wO'
    }
  }));
  return app;
}

describe('GET /billing/plans geo currency', () => {
  beforeEach(() => {
    invalidateBillingPlansCache();
    invalidateLiveBillingPlansCache();
  });

  test('returns USD priceIds when CF-IPCountry is US', async () => {
    const res = await request(createApp())
      .get('/billing/plans')
      .set('CF-IPCountry', 'US');

    expect(res.status).toBe(200);
    expect(res.body.currency).toBe('usd');
    const byId = Object.fromEntries(res.body.plans.map((plan) => [plan.id, plan]));
    expect(byId.starter.priceId).toBe('price_1UBBZlJl9Rm418cMyqCUYrxp');
    expect(byId.pro.priceId).toBe('price_1UBBOuJl9Rm418cMz5HG1Lnu');
    expect(byId.credits.priceId).toBe('price_1UBBVeJl9Rm418cM1k7PC7wO');
    expect(byId.starter.currency).toBe('usd');
  });

  test('returns GBP priceIds when country is missing/unknown', async () => {
    const res = await request(createApp())
      .get('/billing/plans')
      .set('CF-IPCountry', 'XX');

    expect(res.status).toBe(200);
    expect(res.body.currency).toBe('gbp');
    const byId = Object.fromEntries(res.body.plans.map((plan) => [plan.id, plan]));
    expect(byId.starter.priceId).toBe('price_gbp_starter');
    expect(byId.pro.priceId).toBe('price_gbp_pro');
    expect(byId.credits.priceId).toBe('price_gbp_credits');
    expect(byId.starter.currency).toBe('gbp');
  });

  test('does not use Accept-Language to select USD plans', async () => {
    const res = await request(createApp())
      .get('/billing/plans')
      .set('Accept-Language', 'en-US,en;q=0.9');

    expect(res.status).toBe(200);
    expect(res.body.currency).toBe('gbp');
    expect(res.body.plans.find((plan) => plan.id === 'starter').priceId).toBe('price_gbp_starter');
  });
});
