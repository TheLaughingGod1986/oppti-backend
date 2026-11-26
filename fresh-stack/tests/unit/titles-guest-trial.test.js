const {
  buildGuestReservationKeys,
  buildGuestSiteIdentity,
  deriveGuestSiteKey,
  GUEST_SITE_KEY_PREFIX,
  TITLES_GUEST_CREDITS_PER_TRY
} = require('../../services/titlesGuestTrial');
const { getAnonymousTrialLimit } = require('../../services/anonymousTrial');

function fakeReq(headers = {}, body = {}) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { header: (name) => lower[String(name).toLowerCase()], body };
}

describe('deriveGuestSiteKey', () => {
  test('is the same for every spelling of one site URL', () => {
    const key = deriveGuestSiteKey('https://shop.example.com');
    expect(key.startsWith(GUEST_SITE_KEY_PREFIX)).toBe(true);
    expect(deriveGuestSiteKey('http://www.shop.example.com/')).toBe(key);
    expect(deriveGuestSiteKey('shop.example.com')).toBe(key);
    expect(deriveGuestSiteKey('https://SHOP.example.com:443')).toBe(key);
    expect(deriveGuestSiteKey('https://shop.example.com/?utm=1')).toBe(key);
  });

  test('differs by host, port and sub-directory', () => {
    const key = deriveGuestSiteKey('https://shop.example.com');
    expect(deriveGuestSiteKey('https://other.example.com')).not.toBe(key);
    expect(deriveGuestSiteKey('https://shop.example.com/blog')).not.toBe(key);
    expect(deriveGuestSiteKey('https://shop.example.com:8443')).not.toBe(key);
  });

  test('does not depend on any environment value', () => {
    const before = deriveGuestSiteKey('https://shop.example.com');
    const saved = { salt: process.env.ANONYMOUS_ID_SALT, jwt: process.env.JWT_SECRET };
    process.env.ANONYMOUS_ID_SALT = 'rotated';
    process.env.JWT_SECRET = 'rotated';
    expect(deriveGuestSiteKey('https://shop.example.com')).toBe(before);
    if (saved.salt === undefined) delete process.env.ANONYMOUS_ID_SALT; else process.env.ANONYMOUS_ID_SALT = saved.salt;
    if (saved.jwt === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = saved.jwt;
  });

  test('returns null for a missing or unparseable URL', () => {
    expect(deriveGuestSiteKey(null)).toBeNull();
    expect(deriveGuestSiteKey('')).toBeNull();
    expect(deriveGuestSiteKey('http://')).toBeNull();
  });
});

describe('buildGuestSiteIdentity', () => {
  test('ignores the plugin site id, install hash and fingerprint', () => {
    const { siteIdentity, guestSiteKey, error } = buildGuestSiteIdentity(fakeReq({
      'X-Site-URL': 'https://shop.example.com',
      'X-Trial-Site-Hash': 'random-plugin-id-0123456789abcdef',
      'X-Install-Hash': 'install-uuid',
      'X-Site-Fingerprint': 'fp'
    }));
    expect(error).toBeNull();
    expect(siteIdentity.siteHash).toBe(guestSiteKey);
    expect(siteIdentity.wpInstallUuid).toBe(guestSiteKey);
    expect(siteIdentity.siteFingerprint).toBeNull();
    expect(siteIdentity.normalizedSiteUrl).toBe('shop.example.com');
  });

  test('falls back to the body trial_site_url', () => {
    const { guestSiteKey } = buildGuestSiteIdentity(fakeReq({}, { trial_site_url: 'https://shop.example.com' }));
    expect(guestSiteKey).toBe(deriveGuestSiteKey('https://shop.example.com'));
  });

  test('allows development hosts, as the Alt Text guest path does', () => {
    const { error, siteIdentity } = buildGuestSiteIdentity(fakeReq({ 'X-Site-URL': 'http://localhost:8080' }));
    expect(error).toBeNull();
    expect(siteIdentity.isDevelopment).toBe(true);
  });

  test('without a site URL it refuses', () => {
    expect(buildGuestSiteIdentity(fakeReq({})).error).toBe('GUEST_SITE_URL_REQUIRED');
  });
});

describe('guest cap and reservation keys', () => {
  test('a guest try is one credit from the shared trial limit (10 by default)', () => {
    expect(TITLES_GUEST_CREDITS_PER_TRY).toBe(1);
    const saved = process.env.ANONYMOUS_TRIAL_CREDITS;
    delete process.env.ANONYMOUS_TRIAL_CREDITS;
    if (!process.env.SITE_TRIAL_CREDITS && !process.env.TRIAL_LIMIT) {
      expect(getAnonymousTrialLimit()).toBe(10);
    }
    if (saved !== undefined) process.env.ANONYMOUS_TRIAL_CREDITS = saved;
  });

  test('keys are unique per request even for identical input', () => {
    const a = buildGuestReservationKeys('same');
    const b = buildGuestReservationKeys('same');
    expect(a.idempotencyKey).not.toBe(b.idempotencyKey);
    expect(a.requestFingerprint).not.toBe(b.requestFingerprint);
    expect(a.idempotencyKey).toMatch(/^titles-guest:[0-9a-f-]{36}$/);
  });
});
