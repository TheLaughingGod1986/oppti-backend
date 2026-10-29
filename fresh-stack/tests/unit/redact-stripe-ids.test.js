const { redactStripeIds, redactStripeIdsInString } = require('../../lib/redact');

describe('redactStripeIds', () => {
  test('masks customer, subscription and checkout session ids, keeping prefix and last 4', () => {
    expect(redactStripeIdsInString('cus_ABCDEFGHIJ1234')).toBe('cus_***1234');
    expect(redactStripeIdsInString('sub_1PqRsTuVwXyZ9876')).toBe('sub_***9876');
    expect(redactStripeIdsInString('cs_test_a1B2c3D4e5F6g7H8')).toBe('cs_test_***g7H8');
    expect(redactStripeIdsInString('cs_live_a1B2c3D4e5F6g7H8')).toBe('cs_live_***g7H8');
  });

  test('short ids are fully masked', () => {
    expect(redactStripeIdsInString('cus_123')).toBe('cus_***');
    expect(redactStripeIdsInString("No such customer: 'cus_abc'")).toBe("No such customer: 'cus_***'");
  });

  test('leaves other text and ids alone', () => {
    expect(redactStripeIdsInString('price_123 prod_456 acct-own focus_mode')).toBe('price_123 prod_456 acct-own focus_mode');
  });

  test('walks objects and arrays without mutating input', () => {
    const input = { customer: 'cus_ABCDEFGHIJ1234', nested: { list: ['sub_ABCDEFGHIJ5678', 3, null] }, ok: true };
    const out = redactStripeIds(input);
    expect(out).toEqual({ customer: 'cus_***1234', nested: { list: ['sub_***5678', 3, null] }, ok: true });
    expect(input.customer).toBe('cus_ABCDEFGHIJ1234');
  });
});
