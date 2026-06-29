describe('Loops lifecycle events', () => {
  const originalApiKey = process.env.LOOPS_API_KEY;
  const originalFetch = global.fetch;

  beforeEach(() => {
    jest.resetModules();
    process.env.LOOPS_API_KEY = 'loops_test_key';
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: jest.fn().mockResolvedValue({ success: true })
    });
  });

  afterEach(() => {
    process.env.LOOPS_API_KEY = originalApiKey;
    global.fetch = originalFetch;
  });

  test('sends plan upgrades as idempotent event properties', async () => {
    const { trackPlanUpgraded } = require('../../../src/services/loops');

    await trackPlanUpgraded({
      email: 'buyer@example.com',
      planName: 'pro',
      purchaseType: 'new_purchase',
      billingPeriod: 'monthly',
      amount: 14.99,
      currency: 'usd',
      stripeEventId: 'evt_purchase_123'
    });

    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(global.fetch).toHaveBeenLastCalledWith(
      'https://app.loops.so/api/v1/events/send',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer loops_test_key',
          'Idempotency-Key': 'evt_purchase_123'
        }),
        body: JSON.stringify({
          email: 'buyer@example.com',
          eventName: 'plan_upgraded',
          eventProperties: {
            plan: 'pro',
            purchaseType: 'new_purchase',
            billingPeriod: 'monthly',
            amount: 14.99,
            currency: 'usd',
            stripeEventId: 'evt_purchase_123'
          }
        })
      })
    );
  });

  test('sends payment failures as idempotent event properties', async () => {
    const { trackPaymentFailed } = require('../../../src/services/loops');

    await trackPaymentFailed({
      email: 'buyer@example.com',
      planName: 'credits',
      amount: 9.99,
      currency: 'gbp',
      failureCode: 'card_declined',
      declineCode: 'insufficient_funds',
      recoverability: 'recoverable',
      paymentIntentId: 'pi_failed_123',
      chargeId: 'ch_failed_123',
      paymentLinkId: 'plink_credits',
      checkoutSessionId: 'cs_failed_123',
      stripeEventId: 'evt_failed_123'
    });

    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(global.fetch).toHaveBeenLastCalledWith(
      'https://app.loops.so/api/v1/events/send',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer loops_test_key',
          'Idempotency-Key': 'evt_failed_123'
        }),
        body: JSON.stringify({
          email: 'buyer@example.com',
          eventName: 'payment_failed',
          eventProperties: {
            plan: 'credits',
            amount: 9.99,
            currency: 'gbp',
            failureCode: 'card_declined',
            declineCode: 'insufficient_funds',
            recoverability: 'recoverable',
            paymentIntentId: 'pi_failed_123',
            chargeId: 'ch_failed_123',
            paymentLinkId: 'plink_credits',
            checkoutSessionId: 'cs_failed_123',
            stripeEventId: 'evt_failed_123'
          }
        })
      })
    );
  });
});
