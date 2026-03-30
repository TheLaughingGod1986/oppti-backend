const {
  buildSiteIdentity,
  normalizeSiteUrl,
  isDevelopmentHost,
  generateSyntheticSiteHash
} = require('../../lib/siteIdentity');

describe('siteIdentity', () => {
  test('normalizes site urls and strips protocol noise', () => {
    const result = normalizeSiteUrl('HTTPS://WWW.Example.com:443/wp-admin/');

    expect(result.isValid).toBe(true);
    expect(result.canonicalDomain).toBe('example.com');
    expect(result.normalizedSiteUrl).toBe('example.com/wp-admin');
  });

  test('preserves meaningful subdomains', () => {
    const result = normalizeSiteUrl('https://shop.example.com/store/');

    expect(result.canonicalDomain).toBe('shop.example.com');
    expect(result.normalizedSiteUrl).toBe('shop.example.com/store');
  });

  test('flags localhost and private hosts as development identities', () => {
    expect(isDevelopmentHost('localhost')).toBe(true);
    expect(isDevelopmentHost('127.0.0.1')).toBe(true);
    expect(isDevelopmentHost('staging.example.com')).toBe(false);
  });

  test('rejects development identities in production mode by default', () => {
    const originalNodeEnv = process.env.NODE_ENV;
    const originalAllow = process.env.ALLOW_DEV_SITE_QUOTA;
    process.env.NODE_ENV = 'production';
    delete process.env.ALLOW_DEV_SITE_QUOTA;

    const identity = buildSiteIdentity({
      siteUrl: 'http://localhost:8888',
      siteHash: 'local-site-id'
    });

    expect(identity.error).toBe('DEVELOPMENT_SITE_NOT_ALLOWED');
    expect(identity.isAllowed).toBe(false);

    process.env.NODE_ENV = originalNodeEnv;
    process.env.ALLOW_DEV_SITE_QUOTA = originalAllow;
  });

  test('prefers install uuid while preserving legacy site hash', () => {
    const identity = buildSiteIdentity({
      siteUrl: 'https://example.com',
      siteHash: 'legacy-site-hash',
      installUuid: 'wp-install-uuid'
    });

    expect(identity.wpInstallUuid).toBe('wp-install-uuid');
    expect(identity.siteHash).toBe('legacy-site-hash');
    expect(identity.canonicalDomain).toBe('example.com');
  });

  test('generates a deterministic synthetic site hash when no hash is provided', () => {
    const first = generateSyntheticSiteHash({
      siteFingerprint: 'fingerprint-1',
      normalizedSiteUrl: 'example.com',
      canonicalDomain: 'example.com'
    });
    const second = generateSyntheticSiteHash({
      siteFingerprint: 'fingerprint-1',
      normalizedSiteUrl: 'example.com',
      canonicalDomain: 'example.com'
    });

    expect(first).toHaveLength(64);
    expect(first).toBe(second);
  });
});
