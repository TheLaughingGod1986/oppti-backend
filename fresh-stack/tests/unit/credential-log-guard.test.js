// Guard: no credential characters in any log. Log helpers report presence
// only, and no source line slices a licence key, site key/hash, secret or token.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { eightCharSlices } = require('../helpers/credentialSlices');

const ROOT = path.join(__dirname, '..', '..');
const KEY = 'QA-FAKE-LICENSE-KEY-0001';

function sourceFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'tests' || entry.name === 'node_modules' ? [] : sourceFiles(full);
    return entry.name.endsWith('.js') ? [full] : [];
  });
}

function loadHelper(file, name) {
  const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const match = source.match(new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`));
  expect(match).not.toBeNull();
  const sandbox = {};
  vm.runInNewContext(`${match[0]}\nresult = ${name};`, sandbox);
  return sandbox.result;
}

describe('credential log guard', () => {
  test.each([
    ['routes/billing.js', 'maskSecret'],
    ['services/siteQuota.js', 'maskSecret'],
    ['services/siteQuota.js', 'maskLicenseKeyForCreditAudit'],
    ['services/quota.js', 'maskLicenseKeyForAudit'],
    ['routes/auth.js', 'redactLicenseKey']
  ])('%s %s reports presence only', (file, name) => {
    const helper = loadHelper(file, name);
    const out = helper(KEY);
    expect(out).toBe('present');
    for (const slice of eightCharSlices(KEY)) expect(String(out)).not.toContain(slice);
    expect(helper('short')).toBe('present');
    expect(helper(null)).toBeNull();
    expect(helper('')).toBeNull();
  });

  test('no source line slices a licence key, site key or hash, secret or token', () => {
    // lib/email.js builds the support email body (not a log); reported separately.
    const allowedFiles = new Set(['lib/email.js']);
    const slicing = /([A-Za-z_$][\w$]*(?:\?\.|\.)?[\w$]*)\)?\s*\.(?:substring|slice)\(\s*0\s*,\s*\d+\s*\)/g;
    const credentialName = /(licen[cs]e(?!_?[Ii]d\b)|key|secret|token|site_?hash|sitehash)/i;
    const offenders = [];
    for (const file of sourceFiles(ROOT)) {
      const rel = path.relative(ROOT, file).split(path.sep).join('/');
      if (allowedFiles.has(rel)) continue;
      fs.readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
        for (const match of line.matchAll(slicing)) {
          const name = match[1];
          if (/(Id|_id)$/.test(name) || name === 'cacheKey') continue;
          if (credentialName.test(name)) offenders.push(`${rel}:${index + 1}: ${line.trim()}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  test('bulk job lines log has_site_key, not the site key', () => {
    for (const file of ['routes/jobs.js', 'routes/titles.js']) {
      const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
      const block = source.match(/bulk_job_accepted', \{[\s\S]*?\}\);/)[0];
      expect(block).toContain('has_site_key');
      expect(block).not.toMatch(/(^|[^_])site_key:|^\s*siteKey,?\s*$/m);
    }
  });
});
