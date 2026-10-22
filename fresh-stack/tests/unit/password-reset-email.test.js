/**
 * Password reset link base and email branding (QA review, 22 Oct 2026).
 */
const mockSend = jest.fn().mockResolvedValue({ data: { id: 'em_test' }, error: null });
jest.mock('resend', () => ({ Resend: jest.fn().mockImplementation(() => ({ emails: { send: mockSend } })) }));

const { getPasswordResetBaseUrl, buildPasswordResetLink } = require('../../lib/passwordReset');

function loadEmail() {
  process.env.RESEND_API_KEY = 're_test_dummy';
  let mod;
  jest.isolateModules(() => { mod = require('../../lib/email'); });
  return mod;
}

const savedKey = process.env.RESEND_API_KEY;
afterAll(() => { if (savedKey === undefined) delete process.env.RESEND_API_KEY; else process.env.RESEND_API_KEY = savedKey; });
beforeEach(() => mockSend.mockClear());

describe('password reset base URL', () => {
  test('defaults to https://oppti.dev with no localhost fallback', () => {
    expect(getPasswordResetBaseUrl({})).toBe('https://oppti.dev');
    expect(buildPasswordResetLink('abc', {})).toBe('https://oppti.dev/reset-password?token=abc');
  });

  test.each([
    ['http://localhost:8080', 'https://oppti.dev'],
    ['http://oppti.dev', 'https://oppti.dev'],
    ['javascript:alert(1)', 'https://oppti.dev'],
    ['not a url', 'https://oppti.dev'],
    ['https://user:pw@evil.example', 'https://oppti.dev'],
    ['https://staging.oppti.dev/some/path', 'https://staging.oppti.dev'],
    ['  https://oppti.dev/  ', 'https://oppti.dev']
  ])('PASSWORD_RESET_BASE_URL=%s -> %s', (value, expected) => {
    expect(getPasswordResetBaseUrl({ PASSWORD_RESET_BASE_URL: value })).toBe(expected);
  });

  test('token is URL-encoded into the query string', () => {
    expect(buildPasswordResetLink('a&b=c', {})).toBe('https://oppti.dev/reset-password?token=a%26b%3Dc');
  });
});

describe('password reset email', () => {
  test('OpptiAI subject and body, no AltText AI branding, link escaped in HTML', async () => {
    const email = loadEmail();
    const link = 'https://oppti.dev/reset-password?token=abc&x="<b>';
    const result = await email.sendPasswordResetEmail('reset-owner@qa.oppti.dev', link);
    expect(result.success).toBe(true);
    const msg = mockSend.mock.calls[0][0];
    expect(msg.subject).toBe('Reset your OpptiAI password');
    expect(email.PASSWORD_RESET_SUBJECT).toBe('Reset your OpptiAI password');
    expect(msg.to).toEqual(['reset-owner@qa.oppti.dev']);
    expect(`${msg.subject}${msg.html}${msg.text}`).not.toMatch(/AltText AI|alttext/i);
    expect(msg.html).toContain('OpptiAI');
    expect(msg.html).not.toContain('"<b>');
    expect(msg.html).toContain('&amp;x=&quot;&lt;b&gt;');
    expect(msg.text).toContain(link);
  });

  test('contact email escapes caller-supplied fields so they cannot inject links', async () => {
    const email = loadEmail();
    await email.sendContactEmail({
      name: '<a href="https://evil.example">Ben</a>',
      email: 'sender@qa.oppti.dev',
      subject: '<img src=x>',
      message: 'hi\n<a href="https://evil.example">click</a>',
      siteUrl: 'https://site.example/"><a href="https://evil.example">x</a>'
    });
    const msg = mockSend.mock.calls[0][0];
    expect(msg.html).not.toMatch(/<a href="https:\/\/evil\.example"/);
    expect(msg.html).not.toContain('<img src=x>');
    expect(msg.html).toContain('&lt;a href=&quot;https://evil.example&quot;&gt;');
    expect(`${msg.html}${msg.text}`).not.toMatch(/AltText AI/);
  });
});
