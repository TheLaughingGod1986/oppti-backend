/**
 * Support inbox and sender address (Oct 2026).
 * - Contact mail goes to the requested (allowlisted) inbox first, then any
 *   configured inbox; support@oppti.dev is the default when nothing is set.
 *   No personal inbox is put ahead of the requested recipient.
 * - Sender: EMAIL_FROM, then RESEND_FROM_EMAIL, then noreply@alttext.ai
 *   (unchanged default until oppti.dev is verified in Resend).
 */
const mockSend = jest.fn().mockResolvedValue({ data: { id: 'em_test' }, error: null });
jest.mock('resend', () => ({ Resend: jest.fn().mockImplementation(() => ({ emails: { send: mockSend } })) }));

const ENV_KEYS = ['RESEND_API_KEY', 'EMAIL_FROM', 'RESEND_FROM_EMAIL', 'RESEND_CONTACT_EMAIL', 'CONTACT_SUPPORT_EMAIL', 'SUPPORT_EMAIL', 'CONTACT_EMAIL'];
const saved = {};

function loadEmail(env = {}) {
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, { RESEND_API_KEY: 're_test_dummy' }, env);
  let mod;
  jest.isolateModules(() => { mod = require('../../lib/email'); });
  return mod;
}

beforeAll(() => { for (const k of ENV_KEYS) saved[k] = process.env[k]; });
afterAll(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  }
});
beforeEach(() => mockSend.mockClear());

describe('contact recipients', () => {
  test('defaults to support@oppti.dev when nothing is requested or configured', () => {
    const email = loadEmail();
    expect(email.getContactRecipientEmails()).toEqual(['support@oppti.dev']);
    expect(email.getContactRecipientEmail()).toBe('support@oppti.dev');
  });

  test('requested recipient comes first, configured inboxes after, no default added', () => {
    const email = loadEmail({ RESEND_CONTACT_EMAIL: 'inbox@site.example' });
    expect(email.getContactRecipientEmails('support@oppti.dev')).toEqual(['support@oppti.dev', 'inbox@site.example']);
    expect(email.getContactRecipientEmail('support@oppti.dev')).toBe('support@oppti.dev');
  });

  test('no gmail address is ever added by default', () => {
    const email = loadEmail();
    expect(email.getContactRecipientEmails('support@oppti.dev').join(',')).not.toMatch(/gmail/i);
  });

  test('sendContactEmail sends to support@oppti.dev with the user as reply-to', async () => {
    const email = loadEmail();
    const result = await email.sendContactEmail({ to: undefined, name: 'Pat', email: 'pat@site.example', subject: 'Help', message: 'Hello there, need help.' });
    expect(result.success).toBe(true);
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend.mock.calls[0][0].to).toEqual(['support@oppti.dev']);
    expect(mockSend.mock.calls[0][0].replyTo).toBe('pat@site.example');
  });
});

describe('sender address', () => {
  const sentFrom = async (env) => {
    const email = loadEmail(env);
    await email.sendContactEmail({ name: 'Pat', email: 'pat@site.example', subject: 'Help', message: 'Hello there, need help.' });
    return mockSend.mock.calls[0][0].from;
  };

  test('default is unchanged (noreply@alttext.ai)', async () => {
    expect(await sentFrom({})).toBe('noreply@alttext.ai');
  });

  test('RESEND_FROM_EMAIL still works', async () => {
    expect(await sentFrom({ RESEND_FROM_EMAIL: 'noreply@legacy.example' })).toBe('noreply@legacy.example');
  });

  test('EMAIL_FROM wins over RESEND_FROM_EMAIL', async () => {
    expect(await sentFrom({ EMAIL_FROM: 'OpptiAI <noreply@oppti.dev>', RESEND_FROM_EMAIL: 'noreply@legacy.example' })).toBe('OpptiAI <noreply@oppti.dev>');
  });

  test('blank EMAIL_FROM falls through', async () => {
    expect(await sentFrom({ EMAIL_FROM: '  ' })).toBe('noreply@alttext.ai');
  });
});

describe('support email body: site hash and licence key as presence only', () => {
  const { expectNoCredentialSlices } = require('../helpers/credentialSlices');
  test('html and text bodies say "present" and carry no characters of either value', async () => {
    const email = loadEmail();
    const siteHash = 'qa-raw-site-key-secret-0001';
    const licenseKey = 'QA-FAKE-LICENSE-KEY-0001';
    await email.sendContactEmail({
      name: 'Pat', email: 'pat@site.example', subject: 'Help', message: 'Hello there, need help.',
      wpVersion: '6.6', pluginVersion: '4.6.143', siteHash, licenseKey
    });
    const sent = mockSend.mock.calls[0][0];
    expect(sent.html).toContain('Site Hash: present');
    expect(sent.html).toContain('License Key: present');
    expect(sent.text).toContain('Site Hash: present');
    expect(sent.text).toContain('License Key: present');
    expectNoCredentialSlices([sent.html, sent.text], [siteHash, licenseKey]);
  });
});
