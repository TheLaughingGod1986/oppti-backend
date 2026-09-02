/**
 * @jest-environment node
 */

describe('stripe USD price defaults', () => {
  const ORIGINAL_ENV = { ...process.env };

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    jest.resetModules();
  });

  test('loads USD price defaults without *_USD env vars', () => {
    process.env.NODE_ENV = 'test';
    process.env.SKIP_ENV_VALIDATION = 'true';
    delete process.env.ALTTEXT_AI_STRIPE_PRICE_STARTER_MONTHLY_USD;
    delete process.env.ALTTEXT_AI_STRIPE_PRICE_PRO_USD;
    delete process.env.ALTTEXT_AI_STRIPE_PRICE_AGENCY_USD;
    delete process.env.ALTTEXT_AI_STRIPE_PRICE_CREDITS_USD;

    const config = require('../../../config/config');

    expect(config.stripePrices.starterUsd).toBe('price_1UBBZlJl9Rm418cMyqCUYrxp');
    expect(config.stripePrices.proUsd).toBe('price_1UBBOuJl9Rm418cMz5HG1Lnu');
    expect(config.stripePrices.agencyUsd).toBe('price_1UBBSDJl9Rm418cMvzW2OxG9');
    expect(config.stripePrices.creditsUsd).toBe('price_1UBBVeJl9Rm418cM1k7PC7wO');
  });

  test('*_USD env vars override defaults without replacing GBP keys', () => {
    process.env.NODE_ENV = 'test';
    process.env.SKIP_ENV_VALIDATION = 'true';
    process.env.ALTTEXT_AI_STRIPE_PRICE_STARTER_MONTHLY = 'price_gbp_starter';
    process.env.ALTTEXT_AI_STRIPE_PRICE_PRO = 'price_gbp_pro';
    process.env.ALTTEXT_AI_STRIPE_PRICE_AGENCY = 'price_gbp_agency';
    process.env.ALTTEXT_AI_STRIPE_PRICE_CREDITS = 'price_gbp_credits';
    process.env.ALTTEXT_AI_STRIPE_PRICE_STARTER_MONTHLY_USD = 'price_custom_usd_starter';
    process.env.ALTTEXT_AI_STRIPE_PRICE_PRO_USD = 'price_custom_usd_pro';

    const config = require('../../../config/config');

    expect(config.stripePrices.starter).toBe('price_gbp_starter');
    expect(config.stripePrices.pro).toBe('price_gbp_pro');
    expect(config.stripePrices.agency).toBe('price_gbp_agency');
    expect(config.stripePrices.credits).toBe('price_gbp_credits');
    expect(config.stripePrices.starterUsd).toBe('price_custom_usd_starter');
    expect(config.stripePrices.proUsd).toBe('price_custom_usd_pro');
    expect(config.stripePrices.agencyUsd).toBe('price_1UBBSDJl9Rm418cMvzW2OxG9');
    expect(config.stripePrices.creditsUsd).toBe('price_1UBBVeJl9Rm418cM1k7PC7wO');
  });
});
