/**
 * POST /api/contact: support@oppti.dev is an allowlisted support_recipient;
 * anything else requested by the client is ignored (default inbox used).
 */
jest.mock('../../lib/email', () => ({
  isAvailable: jest.fn(() => true),
  sendContactEmail: jest.fn().mockResolvedValue({ success: true, messageId: 'em_1' }),
  getContactRecipientEmail: jest.fn((to) => to || 'support@oppti.dev')
}));

const express = require('express');
const request = require('supertest');
const emailService = require('../../lib/email');
const { createContactRouter } = require('../../routes/contact');

const ENV_KEYS = ['RESEND_CONTACT_EMAIL', 'CONTACT_SUPPORT_EMAIL', 'SUPPORT_EMAIL', 'CONTACT_EMAIL'];
const saved = {};
beforeAll(() => { for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; } });
afterAll(() => { for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });
beforeEach(() => jest.clearAllMocks());

let n = 0;
function post(body) {
  const app = express();
  app.use(express.json());
  app.use('/api/contact', createContactRouter({ redis: null }));
  n += 1;
  return request(app)
    .post('/api/contact')
    .set('X-Site-Hash', `sitehash-${n}-abcdef`)
    .set('X-Site-URL', 'https://site.example')
    .send({ name: 'Pat', email: 'pat@site.example', subject: 'Help', message: 'Hello there, need help.', ...body });
}

test('support@oppti.dev is accepted as the requested recipient', async () => {
  const res = await post({ support_recipient: 'support@oppti.dev' });
  expect(res.status).toBe(200);
  expect(emailService.getContactRecipientEmail).toHaveBeenCalledWith('support@oppti.dev');
  expect(emailService.sendContactEmail.mock.calls[0][0].to).toBe('support@oppti.dev');
});

test('a non-allowlisted requested recipient is ignored', async () => {
  const res = await post({ support_recipient: 'attacker@evil.example' });
  expect(res.status).toBe(200);
  expect(emailService.getContactRecipientEmail).toHaveBeenCalledWith(undefined);
  expect(emailService.sendContactEmail.mock.calls[0][0].to).toBe('support@oppti.dev');
});

test('the old personal gmail is no longer an allowlisted recipient', async () => {
  const res = await post({ support_recipient: 'someone@gmail.com' });
  expect(res.status).toBe(200);
  expect(emailService.getContactRecipientEmail).toHaveBeenCalledWith(undefined);
});
