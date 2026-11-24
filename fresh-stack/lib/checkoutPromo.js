/**
 * Optional promotion-code attach for Checkout Session creation.
 * Resolves a customer-facing code to a Stripe promotion_code id. The raw
 * code is never logged. Invalid or ineligible codes are ignored.
 */

const PROMO_CODE_PATTERN = /^[A-Za-z0-9_-]{1,40}$/;

// Locked request/URL parameter name. Other names (code, promo_code) are ignored.
const PROMO_PARAM = 'promo';

// Fixed session-metadata labels. Keys are the customer-facing code in uppercase.
// Unknown valid codes map to 'other'. Never write the raw input into metadata.
const PROMO_METADATA_LABELS = Object.freeze({
  BF2026: 'bf2026'
});

function firstRequestPromo(source) {
  if (!source || typeof source !== 'object') return null;
  const value = source[PROMO_PARAM];
  if (typeof value === 'string' && value.trim()) return value;
  return null;
}

function promoMetadataLabel(rawCode) {
  const code = normalizePromoCode(rawCode);
  if (!code) return null;
  return PROMO_METADATA_LABELS[code.toUpperCase()] || 'other';
}

function attachPromoMetadata(checkoutPayload, label) {
  if (!label || !checkoutPayload || typeof checkoutPayload !== 'object') return;
  if (checkoutPayload.metadata && typeof checkoutPayload.metadata === 'object') {
    checkoutPayload.metadata.promo = label;
  }
  if (checkoutPayload.subscription_data && typeof checkoutPayload.subscription_data.metadata === 'object') {
    checkoutPayload.subscription_data.metadata.promo = label;
  }
  if (checkoutPayload.payment_intent_data && typeof checkoutPayload.payment_intent_data.metadata === 'object') {
    checkoutPayload.payment_intent_data.metadata.promo = label;
  }
}

function normalizePromoCode(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!PROMO_CODE_PATTERN.test(trimmed)) return null;
  return trimmed;
}

function isGbpSessionCurrency(currency) {
  return String(currency || '').trim().toLowerCase() === 'gbp';
}

function couponAllowsGbpSession(coupon) {
  if (!coupon || typeof coupon !== 'object') return false;
  if (coupon.valid === false) return false;
  const percentOff = Number(coupon.percent_off);
  if (Number.isFinite(percentOff) && percentOff > 0) return true;
  const amountOff = Number(coupon.amount_off);
  const currency = String(coupon.currency || '').trim().toLowerCase();
  return Number.isFinite(amountOff) && amountOff > 0 && currency === 'gbp';
}

async function couponFromPromo(stripeClient, promo) {
  const coupon = promo && promo.coupon;
  if (coupon && typeof coupon === 'object') return coupon;
  const couponId = typeof coupon === 'string' ? coupon : null;
  if (!couponId || !stripeClient || typeof stripeClient.coupons?.retrieve !== 'function') {
    return null;
  }
  try {
    return await stripeClient.coupons.retrieve(couponId);
  } catch {
    return null;
  }
}

/**
 * @param {object} stripeClient Stripe SDK client (mocked in tests)
 * @param {unknown} rawCode customer-facing code from the request
 * @param {unknown} sessionCurrency charge currency of the session ('gbp' / 'GBP')
 * @returns {Promise<string|null>} promotion_code id, or null to leave session unchanged
 */
async function resolveCheckoutPromotionCode(stripeClient, rawCode, sessionCurrency) {
  const code = normalizePromoCode(rawCode);
  if (!code) return null;
  if (!isGbpSessionCurrency(sessionCurrency)) return null;
  if (!stripeClient || typeof stripeClient.promotionCodes?.list !== 'function') return null;

  try {
    const listed = await stripeClient.promotionCodes.list({
      code,
      active: true,
      limit: 1,
      expand: ['data.coupon']
    });
    const promo = listed && Array.isArray(listed.data) ? listed.data[0] : null;
    if (!promo || typeof promo.id !== 'string' || !promo.id) return null;
    if (promo.active === false) return null;
    const coupon = await couponFromPromo(stripeClient, promo);
    if (!couponAllowsGbpSession(coupon)) return null;
    return promo.id;
  } catch {
    return null;
  }
}

/**
 * Mutates checkoutPayload: sets discounts when a code applies.
 * Never sets discounts and allow_promotion_codes together.
 * @returns {Promise<boolean>} true when discounts were set
 */
async function applyCheckoutPromotion(stripeClient, checkoutPayload, rawCode, sessionCurrency) {
  if (!checkoutPayload || typeof checkoutPayload !== 'object') return false;
  const promotionCodeId = await resolveCheckoutPromotionCode(stripeClient, rawCode, sessionCurrency);
  if (!promotionCodeId) return false;
  delete checkoutPayload.allow_promotion_codes;
  checkoutPayload.discounts = [{ promotion_code: promotionCodeId }];
  attachPromoMetadata(checkoutPayload, promoMetadataLabel(rawCode));
  return true;
}

module.exports = {
  PROMO_PARAM,
  PROMO_CODE_PATTERN,
  PROMO_METADATA_LABELS,
  firstRequestPromo,
  normalizePromoCode,
  promoMetadataLabel,
  isGbpSessionCurrency,
  couponAllowsGbpSession,
  resolveCheckoutPromotionCode,
  applyCheckoutPromotion
};
