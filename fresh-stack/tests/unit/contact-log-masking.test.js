/**
 * Contact form logs never carry the sender's full email (replyTo), while the
 * Resend message itself still uses the full address as reply-to.
 * Test addresses use @qa.oppti.dev only.
 */
const mockSend = jest.fn();
jest.mock('resend', () => ({ Resend: jest.fn().mockImplementation(() => ({ emails: { send: mockSend } })) }));

const express = require('express');
const request = require('supertest');

const SENDER = 'customer.person@qa.oppti.dev';
const MASKED = 'c***@qa.oppti.dev';
const ENV_KEYS = ['RESEND_API_KEY', 'EMAIL_FROM', 'RESEND_FROM_EMAIL', 'RESEND_CONTACT_EMAIL', 'CONTACT_SUPPORT_EMAIL', 'SUPPORT_EMAIL', 'CONTACT_EMAIL'];
const saved = {};

let logger;
let spies;
function load() {
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.RESEND_API_KEY = 're_test_dummy';
  let mods;
  jest.isolateModules(() => {
    logger = require('../../lib/logger');
    spies = ['info', 'warn', 'error'].map((level) => jest.spyOn(logger, level).mockImplementation(() => {}));
    mods = { email: require('../../lib/email'), contact: require('../../routes/contact') };
  });
  return mods;
}
const logText = () => JSON.stringify(spies.map((spy) => spy.mock.calls));

beforeAll(() => { for (const k of ENV_KEYS) saved[k] = process.env[k]; });
afterAll(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  }
});
beforeEach(() => mockSend.mockReset());
afterEach(() => jest.restoreAllMocks());

const args = { to: 'support@oppti.dev', name: 'Cust', email: SENDER, subject: `Help from ${SENDER}`, message: 'Hi' };

describe('contact email log masking', () => {
  test('success log masks replyTo and subject; the email itself keeps the real reply-to', async () => {
    mockSend.mockResolvedValue({ data: { id: 'em_1' }, error: null });
    const { email } = load();
    const result = await email.sendContactEmail(args);
    expect(result.success).toBe(true);
    expect(mockSend.mock.calls[0][0].replyTo).toBe(SENDER);
    const logs = logText();
    expect(logs).toContain('[Email] Contact form email sent');
    expect(logs).not.toContain(SENDER);
    expect(logs).toContain(MASKED);
  });

  test('Resend error and thrown error logs mask the sender too', async () => {
    mockSend.mockResolvedValueOnce({ data: null, error: { message: `rejected ${SENDER}` } });
    const { email } = load();
    await email.sendContactEmail(args);
    mockSend.mockRejectedValueOnce(new Error(`socket closed for ${SENDER}`));
    await email.sendContactEmail(args);
    const logs = logText();
    expect(logs).toContain('Failed to send contact form email');
    expect(logs).toContain('Error sending contact form email');
    expect(logs).not.toContain(SENDER);
  });

  test('the /api/contact route success log masks the sender email', async () => {
    mockSend.mockResolvedValue({ data: { id: 'em_2' }, error: null });
    const { contact } = load();
    const app = express();
    app.use(express.json());
    app.use('/api/contact', contact.createContactRouter({ redis: null }));
    const res = await request(app)
      .post('/api/contact')
      .set('X-Site-Hash', 'sitehash-mask-abcdef')
      .set('X-Site-URL', 'https://site.example')
      .send({ name: 'Cust', email: SENDER, subject: 'Question', message: 'Hello there, a question.' });
    expect(res.status).toBe(200);
    const logs = logText();
    expect(logs).toContain('[Contact] Contact form submitted successfully');
    expect(logs).not.toContain(SENDER);
    expect(logs).toContain(MASKED);
  });
});
