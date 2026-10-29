jest.mock('../../lib/email', () => ({
  isAvailable: jest.fn(() => true),
  sendCheckoutLinkEmail: jest.fn().mockResolvedValue({ success: true, messageId: 'em_1' }),
  sendPasswordResetEmail: jest.fn(),
  sendContactEmail: jest.fn(),
  sendImageSeoAuditEmail: jest.fn(),
  getContactRecipientEmail: jest.fn(),
  getContactRecipientEmails: jest.fn(() => [])
}));

const express = require('express');
const request = require('supertest');
const emailService = require('../../lib/email');
const logger = require('../../lib/logger');
const { createBillingRouter } = require('../../routes/billing');

const ACCOUNT = { id: 'acct_email_1', email: 'Owner@Example.com', license_key: 'lic_email_1234', plan: 'free' };

function buildApp({ license = ACCOUNT, session } = {}) {
  const stripeClient = {
    checkout: {
      sessions: {
        create: jest.fn(),
        retrieve: jest.fn().mockImplementation(async (id) => {
          if (!session) throw new Error('No such checkout.session');
          return { id, ...session };
        })
      }
    }
  };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.license = license;
    req.authMethod = license ? 'license' : undefined;
    next();
  });
  app.use('/billing', createBillingRouter({ supabase: null, getStripe: () => stripeClient, priceIds: { starter: 'price_starter' } }));
  return { app, stripeClient };
}

const OPEN_SESSION = {
  status: 'open',
  url: 'https://checkout.stripe.com/c/pay/cs_test_abc123',
  client_reference_id: 'acct_email_1',
  metadata: { account_id: 'acct_email_1', plan: 'starter' }
};

describe('POST /billing/checkout/email-link', () => {
  beforeEach(() => {
    emailService.sendCheckoutLinkEmail.mockClear();
    emailService.isAvailable.mockReturnValue(true);
  });

  test('emails the open session URL to the account email on file only', async () => {
    const { app, stripeClient } = buildApp({ session: OPEN_SESSION });
    const res = await request(app).post('/billing/checkout/email-link').send({ session_id: 'cs_test_abc123' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.sent_to).toBe('ow***@example.com');
    expect(stripeClient.checkout.sessions.retrieve).toHaveBeenCalledWith('cs_test_abc123');
    expect(emailService.sendCheckoutLinkEmail).toHaveBeenCalledWith({
      to: 'owner@example.com',
      checkoutUrl: OPEN_SESSION.url,
      planLabel: 'the Starter plan'
    });
  });

  test('refuses any caller-supplied recipient', async () => {
    const { app } = buildApp({ session: OPEN_SESSION });
    const res = await request(app).post('/billing/checkout/email-link')
      .send({ session_id: 'cs_test_abc123', to: 'attacker@example.net' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('RECIPIENT_NOT_ALLOWED');
    expect(emailService.sendCheckoutLinkEmail).not.toHaveBeenCalled();
  });

  test('requires an authenticated account with an email', async () => {
    const { app } = buildApp({ license: null, session: OPEN_SESSION });
    const res = await request(app).post('/billing/checkout/email-link').send({ session_id: 'cs_test_abc123' });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('AUTH_REQUIRED');
  });

  test('rejects a session owned by another account', async () => {
    const { app } = buildApp({ session: { ...OPEN_SESSION, client_reference_id: 'someone_else', metadata: { account_id: 'someone_else' } } });
    const res = await request(app).post('/billing/checkout/email-link').send({ session_id: 'cs_test_abc123' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SESSION_NOT_OWNED');
    expect(emailService.sendCheckoutLinkEmail).not.toHaveBeenCalled();
  });

  test('rejects malformed ids and expired sessions', async () => {
    const { app } = buildApp({ session: { ...OPEN_SESSION, status: 'expired' } });
    const bad = await request(app).post('/billing/checkout/email-link').send({ session_id: 'https://evil.example/x' });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('INVALID_SESSION_ID');
    const expired = await request(app).post('/billing/checkout/email-link').send({ session_id: 'cs_test_abc123' });
    expect(expired.status).toBe(410);
    expect(expired.body.code).toBe('SESSION_NOT_OPEN');
  });

  test('rate limits per account and never logs the email address', async () => {
    const license = { ...ACCOUNT, id: 'acct_rate_1' };
    const session = { ...OPEN_SESSION, client_reference_id: 'acct_rate_1' };
    const { app } = buildApp({ license, session });
    const infoSpy = jest.spyOn(logger, 'info').mockImplementation(() => {});
    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {});

    for (let i = 0; i < 3; i += 1) {
      const ok = await request(app).post('/billing/checkout/email-link').send({ session_id: 'cs_test_abc123' });
      expect(ok.status).toBe(200);
    }
    const limited = await request(app).post('/billing/checkout/email-link').send({ session_id: 'cs_test_abc123' });
    expect(limited.status).toBe(429);
    expect(limited.body.code).toBe('CHECKOUT_LINK_EMAIL_RATE_LIMITED');
    expect(emailService.sendCheckoutLinkEmail).toHaveBeenCalledTimes(3);

    const logged = JSON.stringify([...infoSpy.mock.calls, ...warnSpy.mock.calls]);
    expect(logged).toContain('checkout_link_email');
    expect(logged.toLowerCase()).not.toContain('owner@example.com');
    infoSpy.mockRestore();
    warnSpy.mockRestore();
  });
});
