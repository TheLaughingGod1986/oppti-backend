const { redactEmails, redactEmailsInString } = require('../../lib/redact');
const logger = require('../../lib/logger');

describe('email redaction for billing logs', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    logger.clearRecentEntries();
  });

  test('masks emails inside Stripe-style messages', () => {
    expect(redactEmailsInString('Invalid email address: jane.doe+shop@example.co.uk'))
      .toBe('Invalid email address: j***@example.co.uk');
    expect(redactEmailsInString('no email here')).toBe('no email here');
  });

  test('masks nested objects, arrays and Error fields', () => {
    const err = new Error('No such customer with email bob@corp.io');
    err.type = 'StripeInvalidRequestError';
    err.code = 'resource_missing';
    err.statusCode = 400;
    err.raw = { message: 'No such customer with email bob@corp.io', headers: { secret: 'x' } };
    const out = redactEmails({ error_message: 'a@b.com', list: ['c@d.org'], error: err });
    expect(out.error_message).toBe('a***@b.com');
    expect(out.list[0]).toBe('c***@d.org');
    expect(out.error.message).toBe('No such customer with email b***@corp.io');
    expect(out.error.raw_message).toBe('No such customer with email b***@corp.io');
    expect(out.error.code).toBe('resource_missing');
    expect(out.error.statusCode).toBe(400);
    expect(JSON.stringify(out)).not.toMatch(/bob@corp\.io/);
    expect(out.error.headers).toBeUndefined();
  });

  test('handles circular structures', () => {
    const a = { email: 'x@y.com' };
    a.self = a;
    const out = redactEmails(a);
    expect(out.email).toBe('x***@y.com');
    expect(out.self).toBe('[Circular]');
  });

  test('withEmailRedaction() logger masks before writing and spies still see the call', () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const errSpy = jest.spyOn(logger, 'error');
    const billingLogger = logger.withEmailRedaction();
    billingLogger.error('[billing] checkout_outcome', { error_message: 'Invalid email address: qa-live@qa.oppti.dev' });
    expect(errSpy).toHaveBeenCalledTimes(1);
    const printed = JSON.stringify(spy.mock.calls);
    expect(printed).not.toMatch(/qa-live@qa\.oppti\.dev/);
    expect(printed).toMatch(/q\*\*\*@qa\.oppti\.dev/);
    const recent = JSON.stringify(logger.getRecentEntries());
    expect(recent).not.toMatch(/qa-live@qa\.oppti\.dev/);
  });
});
