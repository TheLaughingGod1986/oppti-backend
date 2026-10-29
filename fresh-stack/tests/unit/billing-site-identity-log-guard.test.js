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

// QA P1-1 (29 Oct): the scan missed a log object rebuilt by whole-object
// reassignment (billingTrace = { ...billingTrace, site_hash }). These
// fixtures must be flagged; the presence-only form must not.
describe('site identity scan: objects built by reassignment or spread', () => {
  const os = require('os');
  const scanSource = (source) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'site-scan-'));
    const file = path.join(dir, 'fixture.js');
    fs.writeFileSync(file, source);
    try {
      return scanFile(file, dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };

  test.each([
    ['plain reassignment then log', 'let trace = {}; trace = { site_hash: x }; logger.info(trace);'],
    ['QA fixture: trace = {site_hash: x}; logger.info(trace)', 'var trace; trace = {site_hash: x}; logger.info(trace);'],
    ['spread reassignment of a *Trace object', "let billingTrace = { a: 1 }; billingTrace = { ...billingTrace, site_hash: payload.site.site_hash }; logger.info('[billing] t', billingTrace);"],
    ['any variable name that reaches a log call', "let out = {}; out = { ...out, site_hash: k }; logger.warn('m', out);"],
    ['spread into a logged object', "const extra = { site_hash: k }; logger.info('m', { ...extra, ok: true });"],
    ['two hops: spread into a variable that is logged', "const inner = { site_hash: k }; let outer = {}; outer = { ...outer, ...inner }; logger.info('m', outer);"],
    ['a returned trace object', 'function f(site) { const trace = { site_hash: site.site_hash }; return trace; }']
  ])('%s is flagged', (_label, source) => {
    expect(scanSource(source).length).toBeGreaterThan(0);
  });

  test.each([
    ['presence only via siteRefForLog', "let billingTrace = {}; billingTrace = { ...billingTrace, ...siteRefForLog(payload.site.site_hash) }; logger.info('m', billingTrace);"],
    ['a flag', "let trace = {}; trace = { ...trace, has_site_key: Boolean(site_hash) }; logger.info(trace);"],
    ['an object that is never logged', 'let row = {}; row = { ...row, site_hash: k }; db.insert(row);']
  ])('%s is not flagged', (_label, source) => {
    expect(scanSource(source)).toEqual([]);
  });

  test('billing.js webhook traces log presence only', () => {
    const source = fs.readFileSync(BILLING, 'utf8');
    expect(source).not.toMatch(/site_hash:\s*payload\.site\?\.site_hash/);
    expect(source).not.toMatch(/\n\s*site_hash:\s*site\?\.site_hash \|\| eventProperties\?\.site_hash/);
  });
});
