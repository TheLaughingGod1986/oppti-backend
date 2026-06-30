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
            lastPaymentFailureRecoverability: 'recoverable',
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

  test('sends payment successes as idempotent event properties', async () => {
    const { trackPaymentSucceeded } = require('../../../src/services/loops');

    await trackPaymentSucceeded({
      email: 'buyer@example.com',
      planName: 'credits',
      purchaseType: 'credit_top_up',
      billingPeriod: 'one_time',
      amount: 9.99,
      currency: 'gbp',
      checkoutSessionId: 'cs_paid_123',
      invoiceId: null,
      paymentLinkId: 'plink_credits',
      stripeEventId: 'evt_paid_123'
    });

    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(global.fetch).toHaveBeenLastCalledWith(
      'https://app.loops.so/api/v1/events/send',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer loops_test_key',
          'Idempotency-Key': 'evt_paid_123'
        }),
        body: JSON.stringify({
          email: 'buyer@example.com',
          eventName: 'payment_succeeded',
          eventProperties: {
            plan: 'credits',
            purchaseType: 'credit_top_up',
            billingPeriod: 'one_time',
            amount: 9.99,
            currency: 'gbp',
            checkoutSessionId: 'cs_paid_123',
            invoiceId: null,
            paymentLinkId: 'plink_credits',
            stripeEventId: 'evt_paid_123'
          }
        })
      })
    );
  });

  test('sends first generation success for activation workflows', async () => {
    const { trackGenerationMilestone } = require('../../../src/services/loops');

    await trackGenerationMilestone({
      email: 'user@example.com',
      generationsCount: 1,
      imagesUnprocessed: 12
    });

    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(global.fetch).toHaveBeenCalledWith(
      'https://app.loops.so/api/v1/contacts/update',
      expect.objectContaining({
        method: 'PUT',
        headers: expect.objectContaining({
          Authorization: 'Bearer loops_test_key'
        }),
        body: expect.stringContaining('"generationsCount":1')
      })
    );
    expect(global.fetch).toHaveBeenLastCalledWith(
      'https://app.loops.so/api/v1/events/send',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer loops_test_key'
        }),
        body: expect.stringContaining('"eventName":"generation_completed"')
      })
    );
    expect(JSON.parse(global.fetch.mock.calls[1][1].body)).toEqual({
      email: 'user@example.com',
      eventName: 'generation_completed',
      eventProperties: {
        generationsCount: 1,
        imagesUnprocessed: 12,
        lastGenerationAt: expect.any(String)
      }
    });
  });

  test('skips later generation counts after activation', async () => {
    const { trackGenerationMilestone } = require('../../../src/services/loops');

    await trackGenerationMilestone({
      email: 'user@example.com',
      generationsCount: 3,
      imagesUnprocessed: 9
    });
    await trackGenerationMilestone({
      email: 'user@example.com',
      generationsCount: 5,
      imagesUnprocessed: 7
    });

    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('sends image SEO audit completion as lead contact properties and event properties', async () => {
    const { trackImageSeoAuditCompleted } = require('../../../src/services/loops');

    await trackImageSeoAuditCompleted({
      email: 'lead@example.com',
      websiteUrl: 'https://example.com/',
      normalizedDomain: 'example.com',
      auditId: 'audit_123',
      auditScore: 72,
      pagesScanned: 12,
      imagesScanned: 80,
      missingAltPercent: 34
    });

    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(global.fetch).toHaveBeenNthCalledWith(
      1,
      'https://app.loops.so/api/v1/contacts/create',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer loops_test_key'
        }),
        body: JSON.stringify({
          email: 'lead@example.com',
          firstName: '',
          userGroup: 'audit_lead',
          source: 'image_seo_audit',
          websiteUrl: 'https://example.com/',
          normalizedDomain: 'example.com',
          subscribed: true,
          auditScore: 72,
          pagesScanned: 12,
          imagesScanned: 80,
          missingAltPercent: 34
        })
      })
    );
    expect(global.fetch).toHaveBeenLastCalledWith(
      'https://app.loops.so/api/v1/events/send',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          email: 'lead@example.com',
          eventName: 'image_seo_audit_completed',
          eventProperties: {
            auditId: 'audit_123',
            websiteUrl: 'https://example.com/',
            normalizedDomain: 'example.com',
            auditScore: 72,
            pagesScanned: 12,
            imagesScanned: 80,
            missingAltPercent: 34,
            source: 'image_seo_audit'
          }
        })
      })
    );
  });
});
