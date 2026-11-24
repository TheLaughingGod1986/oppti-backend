const {
  PROMO_PARAM,
  firstRequestPromo,
  normalizePromoCode,
  promoMetadataLabel,
  isGbpSessionCurrency,
  couponAllowsGbpSession,
  resolveCheckoutPromotionCode,
  applyCheckoutPromotion
} = require('../../lib/checkoutPromo');

function mockStripe({ listResult, listError, retrieveCoupon } = {}) {
  const list = jest.fn();
  if (listError) list.mockRejectedValue(listError);
  else list.mockResolvedValue(listResult || { data: [] });
  const retrieve = jest.fn();
  if (retrieveCoupon !== undefined) {
    if (retrieveCoupon instanceof Error) retrieve.mockRejectedValue(retrieveCoupon);
    else retrieve.mockResolvedValue(retrieveCoupon);
  }
  return {
    promotionCodes: { list },
    coupons: { retrieve }
  };
}

const GBP_PERCENT = {
  id: 'promo_test_gbp_percent',
  active: true,
  coupon: { id: 'coupon_pct', percent_off: 40, valid: true }
};

describe('normalizePromoCode', () => {
  test('accepts alnum, hyphen and underscore up to 40 characters', () => {
    expect(normalizePromoCode('BF2026')).toBe('BF2026');
    expect(normalizePromoCode('  save_40-off  ')).toBe('save_40-off');
    expect(normalizePromoCode('A'.repeat(40))).toBe('A'.repeat(40));
  });

  test('rejects empty, oversize, or other punctuation', () => {
    expect(normalizePromoCode('')).toBeNull();
    expect(normalizePromoCode('   ')).toBeNull();
    expect(normalizePromoCode(null)).toBeNull();
    expect(normalizePromoCode(40)).toBeNull();
    expect(normalizePromoCode('A'.repeat(41))).toBeNull();
    expect(normalizePromoCode('BF 2026')).toBeNull();
    expect(normalizePromoCode('BF2026!')).toBeNull();
    expect(normalizePromoCode('bf/2026')).toBeNull();
  });
});

describe('firstRequestPromo', () => {
  test('reads only the locked promo param and ignores code or promo_code', () => {
    expect(PROMO_PARAM).toBe('promo');
    expect(firstRequestPromo({ promo: 'AAA', promo_code: 'BBB', code: 'CCC' })).toBe('AAA');
    expect(firstRequestPromo({ promo_code: 'BBB', code: 'CCC' })).toBeNull();
    expect(firstRequestPromo({ code: 'CCC' })).toBeNull();
    expect(firstRequestPromo({ promo: '  ' })).toBeNull();
    expect(firstRequestPromo({})).toBeNull();
    expect(firstRequestPromo(null)).toBeNull();
  });
});

describe('promoMetadataLabel', () => {
  test('maps known codes to a fixed label and unknown valid codes to other', () => {
    expect(promoMetadataLabel('BF2026')).toBe('bf2026');
    expect(promoMetadataLabel('bf2026')).toBe('bf2026');
    expect(promoMetadataLabel('  Bf2026  ')).toBe('bf2026');
    expect(promoMetadataLabel('SAVE40')).toBe('other');
    expect(promoMetadataLabel('BAD CODE!')).toBeNull();
    expect(promoMetadataLabel('')).toBeNull();
  });
});

describe('couponAllowsGbpSession', () => {
  test('accepts percent-off and GBP amount-off coupons', () => {
    expect(couponAllowsGbpSession({ percent_off: 40, valid: true })).toBe(true);
    expect(couponAllowsGbpSession({ amount_off: 200, currency: 'gbp', valid: true })).toBe(true);
    expect(couponAllowsGbpSession({ amount_off: 200, currency: 'GBP' })).toBe(true);
  });

  test('rejects invalid, zero, or non-GBP amount-off coupons', () => {
    expect(couponAllowsGbpSession({ percent_off: 40, valid: false })).toBe(false);
    expect(couponAllowsGbpSession({ percent_off: 0 })).toBe(false);
    expect(couponAllowsGbpSession({ amount_off: 200, currency: 'usd' })).toBe(false);
    expect(couponAllowsGbpSession({ amount_off: 0, currency: 'gbp' })).toBe(false);
    expect(couponAllowsGbpSession(null)).toBe(false);
  });
});

describe('resolveCheckoutPromotionCode', () => {
  test('lists an active code and returns its id for a GBP percent-off coupon', async () => {
    const stripe = mockStripe({ listResult: { data: [GBP_PERCENT] } });
    const id = await resolveCheckoutPromotionCode(stripe, 'BF2026', 'gbp');
    expect(id).toBe('promo_test_gbp_percent');
    expect(stripe.promotionCodes.list).toHaveBeenCalledWith({
      code: 'BF2026',
      active: true,
      limit: 1,
      expand: ['data.coupon']
    });
  });

  test('accepts GBP as the session currency spelling', async () => {
    const stripe = mockStripe({ listResult: { data: [GBP_PERCENT] } });
    await expect(resolveCheckoutPromotionCode(stripe, 'BF2026', 'GBP')).resolves.toBe(
      'promo_test_gbp_percent'
    );
  });

  test('ignores a valid percent-off code when the session is not GBP', async () => {
    const stripe = mockStripe({ listResult: { data: [GBP_PERCENT] } });
    await expect(resolveCheckoutPromotionCode(stripe, 'BF2026', 'usd')).resolves.toBeNull();
    expect(stripe.promotionCodes.list).not.toHaveBeenCalled();
  });

  test('ignores missing, inactive, or empty list results', async () => {
    const missing = mockStripe({ listResult: { data: [] } });
    await expect(resolveCheckoutPromotionCode(missing, 'UNKNOWN', 'gbp')).resolves.toBeNull();

    const inactive = mockStripe({
      listResult: { data: [{ ...GBP_PERCENT, active: false }] }
    });
    await expect(resolveCheckoutPromotionCode(inactive, 'BF2026', 'gbp')).resolves.toBeNull();
  });

  test('ignores a USD amount-off coupon even on a GBP session', async () => {
    const stripe = mockStripe({
      listResult: {
        data: [{
          id: 'promo_usd_amount',
          active: true,
          coupon: { amount_off: 200, currency: 'usd', valid: true }
        }]
      }
    });
    await expect(resolveCheckoutPromotionCode(stripe, 'USD200', 'gbp')).resolves.toBeNull();
  });

  test('retrieves a coupon when list did not expand it', async () => {
    const stripe = mockStripe({
      listResult: { data: [{ id: 'promo_unexpanded', active: true, coupon: 'coupon_pct' }] },
      retrieveCoupon: { id: 'coupon_pct', percent_off: 40, valid: true }
    });
    await expect(resolveCheckoutPromotionCode(stripe, 'BF2026', 'gbp')).resolves.toBe(
      'promo_unexpanded'
    );
    expect(stripe.coupons.retrieve).toHaveBeenCalledWith('coupon_pct');
  });

  test('ignores Stripe lookup errors and invalid input without throwing', async () => {
    const failing = mockStripe({ listError: new Error('network') });
    await expect(resolveCheckoutPromotionCode(failing, 'BF2026', 'gbp')).resolves.toBeNull();
    await expect(resolveCheckoutPromotionCode(failing, 'BAD CODE!', 'gbp')).resolves.toBeNull();
    expect(failing.promotionCodes.list).toHaveBeenCalledTimes(1);
  });
});

describe('applyCheckoutPromotion', () => {
  test('sets discounts and removes allow_promotion_codes when a code applies', async () => {
    const stripe = mockStripe({ listResult: { data: [GBP_PERCENT] } });
    const payload = { mode: 'subscription', allow_promotion_codes: true };
    const applied = await applyCheckoutPromotion(stripe, payload, 'BF2026', 'gbp');
    expect(applied).toBe(true);
    expect(payload.discounts).toEqual([{ promotion_code: 'promo_test_gbp_percent' }]);
    expect(payload.allow_promotion_codes).toBeUndefined();
  });

  test('writes a fixed metadata label, never the raw code, next to existing metadata', async () => {
    const stripe = mockStripe({ listResult: { data: [GBP_PERCENT] } });
    const metadata = { plan: 'starter', utm_source: 'newsletter', plugin_version: '4.6.146' };
    const payload = {
      mode: 'subscription',
      metadata: { ...metadata },
      subscription_data: { metadata: { ...metadata } }
    };
    const applied = await applyCheckoutPromotion(stripe, payload, 'BF2026', 'gbp');
    expect(applied).toBe(true);
    expect(payload.metadata).toEqual({ ...metadata, promo: 'bf2026' });
    expect(payload.subscription_data.metadata).toEqual({ ...metadata, promo: 'bf2026' });
    expect(JSON.stringify(payload.metadata)).not.toContain('BF2026');
    expect(JSON.stringify(payload.subscription_data.metadata)).not.toContain('BF2026');
  });

  test('labels an unknown valid code as other and does not echo the input', async () => {
    const stripe = mockStripe({
      listResult: { data: [{ id: 'promo_unknown_valid', active: true, coupon: { percent_off: 25, valid: true } }] }
    });
    const payload = {
      mode: 'subscription',
      metadata: { plan: 'starter', utm_campaign: 'invite' },
      subscription_data: { metadata: { plan: 'starter', utm_campaign: 'invite' } }
    };
    const applied = await applyCheckoutPromotion(stripe, payload, 'SAVE40', 'gbp');
    expect(applied).toBe(true);
    expect(payload.metadata.promo).toBe('other');
    expect(payload.subscription_data.metadata.promo).toBe('other');
    expect(JSON.stringify(payload)).not.toContain('SAVE40');
  });

  test('leaves the payload unchanged when the code does not apply', async () => {
    const stripe = mockStripe({ listResult: { data: [] } });
    const payload = { mode: 'subscription', metadata: { plan: 'starter' } };
    const applied = await applyCheckoutPromotion(stripe, payload, 'NOPE', 'gbp');
    expect(applied).toBe(false);
    expect(payload.discounts).toBeUndefined();
    expect(payload.metadata.promo).toBeUndefined();
    expect(payload).toEqual({ mode: 'subscription', metadata: { plan: 'starter' } });
  });
});

describe('isGbpSessionCurrency', () => {
  test('treats only GBP spellings as eligible', () => {
    expect(isGbpSessionCurrency('gbp')).toBe(true);
    expect(isGbpSessionCurrency('GBP')).toBe(true);
    expect(isGbpSessionCurrency('usd')).toBe(false);
    expect(isGbpSessionCurrency('')).toBe(false);
  });
});
