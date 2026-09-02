const {
  normalizeCountryCode,
  resolveBillingCountry,
  resolveBillingCurrency,
  selectCatalogPriceIds,
  isUsdPriceId,
  canonicalizePlanKey
} = require('../../lib/billingCurrency');

describe('billingCurrency', () => {
  const priceIds = {
    starter: 'price_gbp_starter',
    pro: 'price_gbp_pro',
    agency: 'price_gbp_agency',
    credits: 'price_gbp_credits',
    starterUsd: 'price_1UBBZlJl9Rm418cMyqCUYrxp',
    proUsd: 'price_1UBBOuJl9Rm418cMz5HG1Lnu',
    agencyUsd: 'price_1UBBSDJl9Rm418cMvzW2OxG9',
    creditsUsd: 'price_1UBBVeJl9Rm418cM1k7PC7wO'
  };

  test('normalizeCountryCode treats XX/T1/invalid as unknown', () => {
    expect(normalizeCountryCode('US')).toBe('US');
    expect(normalizeCountryCode('gb')).toBe('GB');
    expect(normalizeCountryCode('XX')).toBeNull();
    expect(normalizeCountryCode('T1')).toBeNull();
    expect(normalizeCountryCode('')).toBeNull();
    expect(normalizeCountryCode('USA')).toBeNull();
  });

  test('resolveBillingCountry prefers CF-IPCountry over body and ignores locale headers', () => {
    const req = {
      headers: {
        'cf-ipcountry': 'US',
        'accept-language': 'en-GB'
      },
      body: { country: 'GB' }
    };
    expect(resolveBillingCountry(req)).toBe('US');
  });

  test('resolveBillingCountry uses plugin-forwarded visitor country', () => {
    expect(resolveBillingCountry({
      headers: { 'x-visitor-country': 'us' },
      body: {}
    })).toBe('US');
  });

  test('missing/unknown country resolves to GBP currency', () => {
    expect(resolveBillingCurrency(null)).toBe('gbp');
    expect(resolveBillingCurrency('XX')).toBe('gbp');
    expect(resolveBillingCurrency('GB')).toBe('gbp');
    expect(resolveBillingCurrency('US')).toBe('usd');
  });

  test('selectCatalogPriceIds returns USD ids only for US', () => {
    expect(selectCatalogPriceIds(priceIds, 'US').starter).toBe(priceIds.starterUsd);
    expect(selectCatalogPriceIds(priceIds, 'US').pro).toBe(priceIds.proUsd);
    expect(selectCatalogPriceIds(priceIds, 'GB').starter).toBe(priceIds.starter);
    expect(selectCatalogPriceIds(priceIds, null).pro).toBe(priceIds.pro);
  });

  test('isUsdPriceId and canonicalizePlanKey', () => {
    expect(isUsdPriceId(priceIds, priceIds.starterUsd)).toBe(true);
    expect(isUsdPriceId(priceIds, priceIds.starter)).toBe(false);
    expect(canonicalizePlanKey('proUsd')).toBe('pro');
    expect(canonicalizePlanKey('credits')).toBe('credits');
  });
});
