const fs = require('fs');
const path = require('path');

const SKIPPED = ['tester@QA.Oppti.Dev', 'x@EXAMPLE.invalid', ' a@MaxxSpace.com ', 'b@UberIP.COM'];
const NORMAL = 'owner@realsite.com';

describe('loopsRequest enforces the skip list for every path', () => {
  const originalEnv = process.env;
  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv, LOOPS_API_KEY: 'test-key', LOOPS_PLUGIN_USERS_LIST_ID: 'list123' };
    delete process.env.LOOPS_SKIP_DOMAINS;
    global.fetch = jest.fn().mockImplementation(async () => ({
      ok: true, status: 200, json: jest.fn().mockResolvedValue([])
    }));
  });
  afterEach(() => { process.env = originalEnv; delete global.fetch; });

  const tracks = [
    ['trackPlanUpgraded', { planName: 'pro', stripeEventId: 'evt_1' }, 'plan_upgraded'],
    ['trackPaymentFailed', { planName: 'pro', stripeEventId: 'evt_2' }, 'payment_failed'],
    ['trackPaymentSucceeded', { planName: 'pro', stripeEventId: 'evt_3' }, 'payment_succeeded']
  ];

  for (const [fn, extra, eventName] of tracks) {
    test.each(SKIPPED)(`${fn} sends nothing for %s`, async (email) => {
      const loops = require('../../../src/services/loops');
      await loops[fn]({ email, ...extra });
      expect(global.fetch).not.toHaveBeenCalled();
    });
    test(`${fn} still sends for a normal email`, async () => {
      const loops = require('../../../src/services/loops');
      await loops[fn]({ email: NORMAL, ...extra });
      const urls = global.fetch.mock.calls.map(([u]) => String(u));
      expect(urls.some((u) => u.includes('/contacts/update'))).toBe(true);
      const ev = global.fetch.mock.calls.find(([u]) => String(u).includes('/events/send'));
      expect(JSON.parse(ev[1].body)).toMatchObject({ email: NORMAL, eventName });
    });
  }

  test.each(SKIPPED)('contacts/find lookup (query-string email) sends nothing for %s', async (email) => {
    const loops = require('../../../src/services/loops');
    expect(loops.getRequestEmails(`/contacts/find?email=${encodeURIComponent(email)}`, undefined))
      .toEqual([email.trim().toLowerCase()]);
    const result = await loops.findExistingContact(email);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(result).toEqual({ status: 'unknown', contact: null });
  });

  test('contacts/find lookup still runs for a normal email', async () => {
    const loops = require('../../../src/services/loops');
    const result = await loops.findExistingContact(NORMAL);
    expect(result.status).toBe('missing');
    const urls = global.fetch.mock.calls.map(([u]) => String(u));
    expect(urls.some((u) => u.includes(`/contacts/find?email=${encodeURIComponent(NORMAL)}`))).toBe(true);
  });

  test('getRequestEmails reads body.email and query email, lower-cased and trimmed', () => {
    const { getRequestEmails } = require('../../../src/services/loops');
    expect(getRequestEmails('/contacts/find?email=%20A%40QA.oppti.dev', { email: ' B@X.com ' }))
      .toEqual(['b@x.com', 'a@qa.oppti.dev']);
    expect(getRequestEmails('/events/send', null)).toEqual([]);
  });

  test('look-alike and subdomain addresses are not skipped', async () => {
    const loops = require('../../../src/services/loops');
    for (const email of ['a@sub.qa.oppti.dev', 'a@qa.oppti.dev.evil.com', 'a@notuberip.com', 'a@uberip.com.au']) {
      global.fetch.mockClear();
      await loops.trackPaymentSucceeded({ email, planName: 'pro' });
      expect(global.fetch).toHaveBeenCalled();
    }
  });
});

// Load the Deno edge function's ESM skip helper in CommonJS for testing.
function loadEdgeSkip() {
  const file = path.join(__dirname, '../../../supabase/functions/check-inactive-users/skip.js');
  const src = fs.readFileSync(file, 'utf8').replace(/^export /gm, '');
  // eslint-disable-next-line no-new-func
  return new Function(`${src}\nreturn { DEFAULT_LOOPS_SKIP_DOMAINS, getSkipDomains, isLoopsSkippedEmail };`)();
}

describe('check-inactive-users edge function skip filter', () => {
  const edge = loadEdgeSkip();

  test.each(SKIPPED)('skips %s', (email) => {
    expect(edge.isLoopsSkippedEmail(email, undefined)).toBe(true);
  });

  test.each([NORMAL, 'a@sub.qa.oppti.dev', 'a@uberip.com.au', 'a@notuberip.com', '', null, 'no-at'])('does not skip %s', (email) => {
    expect(edge.isLoopsSkippedEmail(email, undefined)).toBe(false);
  });

  test('LOOPS_SKIP_DOMAINS env replaces the default, even when empty', () => {
    expect(edge.isLoopsSkippedEmail('a@custom.test', 'custom.test')).toBe(true);
    expect(edge.isLoopsSkippedEmail('a@qa.oppti.dev', 'custom.test')).toBe(false);
    expect(edge.isLoopsSkippedEmail('a@qa.oppti.dev', '')).toBe(false);
  });

  test('index.ts filters before sending user_inactive_14_days', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../../supabase/functions/check-inactive-users/index.ts'), 'utf8');
    expect(src).toMatch(/import \{ isLoopsSkippedEmail \} from '\.\/skip\.js'/);
    const guard = src.indexOf('isLoopsSkippedEmail(user.email');
    const send = src.indexOf("user_inactive_14_days");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(send);
  });

  test('drift: edge skip list matches src/services/loops.js', () => {
    const backendSrc = fs.readFileSync(path.join(__dirname, '../../../src/services/loops.js'), 'utf8');
    const m = backendSrc.match(/const DEFAULT_LOOPS_SKIP_DOMAINS = '([^']*)'/);
    expect(m).toBeTruthy();
    const norm = (s) => s.split(',').map((d) => d.trim().toLowerCase()).filter(Boolean).sort();
    expect(norm(edge.DEFAULT_LOOPS_SKIP_DOMAINS)).toEqual(norm(m[1]));
    expect(norm(require('../../../src/services/loops').DEFAULT_LOOPS_SKIP_DOMAINS)).toEqual(norm(m[1]));
  });
});
