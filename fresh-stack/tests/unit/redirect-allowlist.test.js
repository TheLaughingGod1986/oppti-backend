/**
 * Stripe redirect host allowlist (services/redirectAllowlist).
 */
const {
  BILLING_FALLBACK_URLS,
  evaluateBillingRedirect,
  isBillingRedirectEnforced,
  loadAccountSiteHosts,
  resolveBillingRedirect
} = require('../../services/redirectAllowlist');
const { createTableMock } = require('../helpers/tableMock');

const REGISTERED = ['example.com'];

describe('evaluateBillingRedirect', () => {
  test.each([
    ['listed site', 'https://example.com/wp-admin/admin.php?page=bbai&x=1'],
    ['www of a bare registration', 'https://www.example.com/wp-admin/'],
    ['subdomain of a registered host', 'https://shop.example.com/thanks'],
    ['deep subdomain', 'https://a.b.example.com/'],
    ['http is allowed', 'http://example.com/'],
    ['host case and trailing dot', 'https://EXAMPLE.com./x'],
    ['oppti.dev always', 'https://oppti.dev/billing/success'],
    ['www.oppti.dev', 'https://www.oppti.dev/account'],
    ['oppti.dev subdomain', 'https://app.oppti.dev/x']
  ])('allowed: %s', (_label, url) => {
    expect(evaluateBillingRedirect(url, REGISTERED)).toMatchObject({ allowed: true, reason: null });
  });

  test('bare URL is allowed when the www host was registered', () => {
    expect(evaluateBillingRedirect('https://example.com/', ['www.example.com']).allowed).toBe(true);
  });

  test.each([
    ['hostile host', 'https://attacker.test/phish', 'host_not_registered', 'attacker.test'],
    ['lookalike prefix', 'https://evilexample.com/', 'host_not_registered', 'evilexample.com'],
    ['registered host as a subdomain of the attacker', 'https://example.com.attacker.test/', 'host_not_registered', 'example.com.attacker.test'],
    ['oppti.dev lookalike', 'https://oppti.dev.attacker.test/', 'host_not_registered', 'oppti.dev.attacker.test'],
    ['javascript scheme', 'javascript:alert(1)', 'scheme_not_allowed', null],
    ['data scheme', 'data:text/html,hi', 'scheme_not_allowed', null],
    ['ftp scheme', 'ftp://example.com/', 'scheme_not_allowed', 'example.com'],
    ['userinfo trick (example.com@attacker.test)', 'https://example.com@attacker.test/', 'credentials_in_url', 'attacker.test'],
    ['user:pass on a listed host', 'https://user:pw@example.com/', 'credentials_in_url', 'example.com'],
    ['relative URL', '/wp-admin/', 'invalid_url', null],
    ['protocol-relative', '//attacker.test/', 'invalid_url', null],
    ['not a string', { href: 'https://example.com' }, 'invalid_url', null]
  ])('refused: %s', (_label, url, reason, host) => {
    const result = evaluateBillingRedirect(url, REGISTERED);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe(reason);
    if (host) expect(result.host).toBe(host);
  });

  test('an account with no registered site only gets oppti.dev', () => {
    expect(evaluateBillingRedirect('https://example.com/', [])).toMatchObject({ allowed: false, reason: 'no_registered_site' });
    expect(evaluateBillingRedirect('https://oppti.dev/account', []).allowed).toBe(true);
  });

  test('a registered single-label host never allows subdomains (no "com" wildcard)', () => {
    expect(evaluateBillingRedirect('https://attacker.com/', ['com']).allowed).toBe(false);
  });
});

describe('resolveBillingRedirect', () => {
  const makeLogger = () => ({ warn: jest.fn() });
  const hostile = 'https://attacker.test/landing?email=victim%40qa.oppti.dev&token=abc123';

  test('no caller URL keeps the route default (null) and logs nothing', () => {
    const logger = makeLogger();
    expect(resolveBillingRedirect({ url: undefined, field: 'successUrl', fallbackUrl: BILLING_FALLBACK_URLS.success, registeredHosts: REGISTERED, logger, env: {} })).toBeNull();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  test('flag off: hostile URL used as sent, one warning with the host only', () => {
    const logger = makeLogger();
    const url = resolveBillingRedirect({ url: hostile, field: 'successUrl', fallbackUrl: BILLING_FALLBACK_URLS.success, registeredHosts: REGISTERED, logger, context: { route: 'checkout' }, env: {} });
    expect(url).toBe(hostile);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const [message, fields] = logger.warn.mock.calls[0];
    expect(message).toBe('[billing] redirect_url_not_allowlisted');
    expect(fields).toMatchObject({ field: 'successUrl', host: 'attacker.test', enforced: false, action: 'used_as_sent', route: 'checkout' });
    const text = JSON.stringify(logger.warn.mock.calls);
    expect(text).not.toMatch(/landing|email=|victim|token|abc123|qa\.oppti\.dev/);
  });

  test('flag on: hostile URL replaced by the oppti.dev fallback, never an error', () => {
    const logger = makeLogger();
    const env = { BILLING_REDIRECT_ALLOWLIST_ENFORCE: 'true' };
    expect(resolveBillingRedirect({ url: hostile, field: 'successUrl', fallbackUrl: BILLING_FALLBACK_URLS.success, registeredHosts: REGISTERED, logger, env }))
      .toBe('https://oppti.dev/billing/success?session_id={CHECKOUT_SESSION_ID}');
    expect(resolveBillingRedirect({ url: hostile, field: 'cancelUrl', fallbackUrl: BILLING_FALLBACK_URLS.cancel, registeredHosts: REGISTERED, logger, env }))
      .toBe('https://oppti.dev/billing/cancel');
    expect(resolveBillingRedirect({ url: 'javascript:alert(1)', field: 'returnUrl', fallbackUrl: BILLING_FALLBACK_URLS.portalReturn, registeredHosts: [], logger, env }))
      .toBe('https://oppti.dev/account');
    expect(logger.warn.mock.calls.every(([, fields]) => fields.enforced === true && fields.action === 'fallback')).toBe(true);
    expect(JSON.stringify(logger.warn.mock.calls)).not.toMatch(/landing|victim|abc123/);
  });

  test('flag on: a listed URL passes through untouched and logs nothing', () => {
    const logger = makeLogger();
    const listed = 'https://www.example.com/wp-admin/admin.php?page=bbai-billing&checkout=success';
    expect(resolveBillingRedirect({ url: listed, field: 'successUrl', fallbackUrl: BILLING_FALLBACK_URLS.success, registeredHosts: REGISTERED, logger, env: { BILLING_REDIRECT_ALLOWLIST_ENFORCE: '1' } })).toBe(listed);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  test.each([
    [undefined, false], ['', false], ['0', false], ['false', false], ['off', false],
    ['1', true], ['true', true], ['TRUE', true], ['on', true], ['yes', true]
  ])('BILLING_REDIRECT_ALLOWLIST_ENFORCE=%p -> %p', (value, expected) => {
    expect(isBillingRedirectEnforced(value === undefined ? {} : { BILLING_REDIRECT_ALLOWLIST_ENFORCE: value })).toBe(expected);
  });
});

describe('loadAccountSiteHosts', () => {
  const supabase = createTableMock({
    sites: [
      { id: 's1', license_key: 'lic-a', site_url: 'https://www.alpha.example' },
      { id: 's2', owner_user_id: 'acct-a', site_url: null, canonical_domain: 'beta.example' },
      { id: 's3', site_url: 'https://gamma.example/blog', normalized_site_url: 'gamma.example/blog' },
      { id: 's4', license_key: 'lic-b', site_url: 'https://not-mine.example' }
    ],
    site_memberships: [{ site_id: 's3', user_id: 'acct-a' }]
  });

  test('license sites, owned sites and member sites, normalised and de-duplicated', async () => {
    const hosts = await loadAccountSiteHosts(supabase, { id: 'acct-a', license_key: 'lic-a' });
    expect(hosts.sort()).toEqual(['alpha.example', 'beta.example', 'gamma.example']);
  });

  test('no account, no database or a throwing database: no hosts, never throws', async () => {
    expect(await loadAccountSiteHosts(supabase, null)).toEqual([]);
    expect(await loadAccountSiteHosts(null, { id: 'acct-a' })).toEqual([]);
    const broken = { from: () => { throw new Error('db down'); } };
    expect(await loadAccountSiteHosts(broken, { id: 'acct-a', license_key: 'lic-a' })).toEqual([]);
  });

  test('extra sites (the X-Site-Key site) are included', async () => {
    const hosts = await loadAccountSiteHosts(null, null, { extraSites: [{ site_url: 'https://delta.example' }] });
    expect(hosts).toEqual(['delta.example']);
  });
});

describe('allowed redirects go to Stripe in the normalised form that was checked', () => {
  const makeQuietLogger = () => ({ warn: jest.fn() });
  test.each([
    ['surrounding spaces are trimmed', '  https://example.com/wp-admin/admin.php?page=bbai  ', 'https://example.com/wp-admin/admin.php?page=bbai'],
    ['backslash becomes a slash', 'https://example.com\\wp-admin\\admin.php', 'https://example.com/wp-admin/admin.php'],
    ['tab and newline are removed', 'https://exa\tmple.com/wp-ad\nmin/', 'https://example.com/wp-admin/'],
    ['host is lower-cased', 'https://EXAMPLE.com/Path', 'https://example.com/Path'],
    ['Stripe placeholder stays literal in the query', 'https://example.com/thanks?session_id={CHECKOUT_SESSION_ID}', 'https://example.com/thanks?session_id={CHECKOUT_SESSION_ID}'],
    ['Stripe placeholder stays literal in the path', 'https://example.com/thanks/{CHECKOUT_SESSION_ID}', 'https://example.com/thanks/{CHECKOUT_SESSION_ID}']
  ])('%s', (_label, raw, expected) => {
    const logger = makeQuietLogger();
    expect(resolveBillingRedirect({ url: raw, field: 'successUrl', fallbackUrl: BILLING_FALLBACK_URLS.success, registeredHosts: REGISTERED, logger, env: {} })).toBe(expected);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  test('success and cancel back to a registered site wp-admin pass unflagged; an unregistered host is flagged', () => {
    const logger = makeQuietLogger();
    const success = 'https://customer.example/wp-admin/admin.php?page=bbai-billing&checkout=success';
    const cancel = 'https://customer.example/wp-admin/admin.php?page=bbai-billing&checkout=cancel';
    const hosts = ['customer.example'];
    expect(resolveBillingRedirect({ url: success, field: 'successUrl', fallbackUrl: BILLING_FALLBACK_URLS.success, registeredHosts: hosts, logger, env: {} })).toBe(success);
    expect(resolveBillingRedirect({ url: cancel, field: 'cancelUrl', fallbackUrl: BILLING_FALLBACK_URLS.cancel, registeredHosts: hosts, logger, env: {} })).toBe(cancel);
    expect(logger.warn).not.toHaveBeenCalled();
    resolveBillingRedirect({ url: 'https://other-shop.example/wp-admin/', field: 'cancelUrl', fallbackUrl: BILLING_FALLBACK_URLS.cancel, registeredHosts: hosts, logger, env: {} });
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][1]).toMatchObject({ field: 'cancelUrl', reason: 'host_not_registered' });
  });
});
