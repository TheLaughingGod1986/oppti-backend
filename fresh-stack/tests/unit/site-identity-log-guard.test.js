/**
 * CI guard: no log line carries a site key, a stored site_hash, an install
 * id/hash/uuid or a site fingerprint. Each of them resolves a site in auth, so
 * logs record only presence (has_site_key / has_install_id /
 * has_site_fingerprint) and which request field carried it (matched_by).
 */
const path = require('path');
const { scanSiteIdentityLogs, scanFile } = require('../helpers/siteIdentityLogScan');
const {
  siteRefForLog,
  installRefForLog,
  fingerprintRefForLog,
  siteKeySource
} = require('../../lib/logIdentity');

const FRESH_STACK = path.resolve(__dirname, '../..');
const SRC = path.resolve(__dirname, '../../../src');

// routes/billing.js is covered by its own guard on the billing branch
// (tests/unit/billing-site-identity-log-guard.test.js); after the merge both
// guards run.
const EXCLUDE = ['routes/billing.js'];

describe('site identity log guard', () => {
  test('no log call in fresh-stack/ or src/ carries a site key, site_hash, install id or fingerprint value', () => {
    const hits = [
      ...scanSiteIdentityLogs(FRESH_STACK, { exclude: EXCLUDE }),
      ...scanSiteIdentityLogs(SRC)
    ];
    expect(hits).toEqual([]);
  });

  test('the scanner flags the shapes it is meant to catch', () => {
    const fs = require('fs');
    const os = require('os');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'site-log-guard-'));
    const file = path.join(dir, 'sample.js');
    fs.writeFileSync(file, [
      "logger.info('a', { site_hash: site.site_hash });",
      "logger.warn('b', { siteKey });",
      "console.log(`site ${siteIdentity.siteHash}`);",
      "logger.info('c', { key: req.header('X-Site-Key') });",
      "logger.info('d', { wp_install_uuid: identity.wpInstallUuid });",
      "const registerTrace = { site_hash: body.site_hash };",
      "logger.info('ok', { ...siteRefForLog(site.site_hash, req), has_install_id: Boolean(installId), lookup_key: siteHash ? 'site_hash' : 'license_key' });",
      "db.from('sites').eq('site_hash', siteHash);"
    ].join('\n'));
    const hits = scanFile(file, dir);
    fs.rmSync(dir, { recursive: true, force: true });
    const lines = hits.map((hit) => Number(hit.split(':')[1].split(' ')[0]));
    expect([...new Set(lines)]).toEqual([1, 2, 3, 4, 5, 6]);
  });
});

describe('lib/logIdentity', () => {
  const req = (headers = {}, body = {}) => ({
    body,
    header: (name) => {
      const hit = Object.keys(headers).find((key) => key.toLowerCase() === name.toLowerCase());
      return hit ? headers[hit] : undefined;
    }
  });

  test('siteRefForLog returns presence and the matching request field, never the value', () => {
    const value = 'qa-raw-site-key-secret-0001';
    expect(siteRefForLog(value)).toEqual({ has_site_key: true });
    expect(siteRefForLog(null)).toEqual({ has_site_key: false });
    expect(siteRefForLog(value, req({ 'X-Site-Key': value }))).toEqual({ has_site_key: true, matched_by: 'X-Site-Key' });
    expect(siteRefForLog(value, req({ 'X-Install-UUID': value }))).toEqual({ has_site_key: true, matched_by: 'X-Install-UUID' });
    expect(siteRefForLog(value, req({}, { installId: value }))).toEqual({ has_site_key: true, matched_by: 'body.installId' });
    expect(siteRefForLog(null, req())).toEqual({ has_site_key: false, matched_by: 'none' });
    expect(JSON.stringify(siteRefForLog(value, req({ 'X-Site-Key': value })))).not.toContain(value);
  });

  test('install id and fingerprint helpers return presence only', () => {
    expect(installRefForLog('uuid-1')).toEqual({ has_install_id: true });
    expect(installRefForLog('')).toEqual({ has_install_id: false });
    expect(fingerprintRefForLog('fp')).toEqual({ has_site_fingerprint: true });
    expect(fingerprintRefForLog(null)).toEqual({ has_site_fingerprint: false });
  });

  test('siteKeySource checks headers before body fields', () => {
    expect(siteKeySource(req({ 'X-Site-Hash': 'a' }, { site_key: 'b' }))).toBe('X-Site-Hash');
    expect(siteKeySource(req({}, { site_hash: 'b' }))).toBe('body.site_hash');
    expect(siteKeySource(null)).toBe('none');
  });
});
