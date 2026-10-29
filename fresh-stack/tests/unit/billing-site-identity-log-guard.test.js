/**
 * Billing routes: no log line carries a site key, a stored site_hash, an
 * install id or a fingerprint (each resolves a site in auth), and PostHog
 * distinct ids are never a raw site key or licence key.
 * The guard for the rest of fresh-stack/ lives on the analytics privacy
 * branch (tests/unit/site-identity-log-guard.test.js); after the merge both run.
 */
const fs = require('fs');
const path = require('path');
const { scanFile } = require('../helpers/siteIdentityLogScan');
const { installIdFromSiteKey } = require('../../lib/installId');

const ROOT = path.resolve(__dirname, '../../..');
const BILLING = path.resolve(__dirname, '../../routes/billing.js');

describe('billing site identity guard', () => {
  test('no billing.js log call carries a site key, site_hash, install id or fingerprint value', () => {
    expect(scanFile(BILLING, ROOT)).toEqual([]);
  });

  test('PostHog distinct ids from Stripe events are never the raw site key or licence key', () => {
    const source = fs.readFileSync(BILLING, 'utf8');
    expect(source).not.toMatch(/distinctId:\s*siteHash\b/);
    expect(source).not.toMatch(/distinctId:\s*licenseKey\b/);
    expect(source).toMatch(/distinctId:\s*installIdFromSiteKey\(siteHash\)/);
  });

  test('checkout metadata site_install_id is computed by the backend, never taken from the body', () => {
    const source = fs.readFileSync(BILLING, 'utf8');
    expect(source).not.toMatch(/bodyIdentity\.siteInstallId/);
    expect(source).toMatch(/site_install_id:\s*installIdFromSiteKey\(/);
  });

  test("install id fixture: sha256('oppti-install-v1:abc')", () => {
    expect(installIdFromSiteKey('abc')).toBe('ea66c63fec4b39dbfd491e385da2298bb0ad9025189b4de4a6c1944918e0aadb');
    expect(installIdFromSiteKey('')).toBeNull();
  });
});
