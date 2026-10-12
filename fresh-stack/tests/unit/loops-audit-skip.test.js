describe('Loops audit-lead paths honour the skip list', () => {
  const originalEnv = process.env;
  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv, LOOPS_API_KEY: 'test-key', LOOPS_PLUGIN_USERS_LIST_ID: 'list123' };
    delete process.env.LOOPS_SKIP_DOMAINS;
    global.fetch = jest.fn().mockImplementation(async () => ({
      ok: true, status: 200, json: jest.fn().mockResolvedValue({ success: true })
    }));
  });
  afterEach(() => { process.env = originalEnv; delete global.fetch; });

  const base = { websiteUrl: 'https://site.test', normalizedDomain: 'site.test', auditId: 'a1' };
  const paths = [
    ['trackImageSeoAuditRequested', {}, 'image_seo_audit_requested'],
    ['trackImageSeoAuditCompleted', { auditScore: 70, pagesScanned: 3, imagesScanned: 9, missingAltPercent: 10 }, 'image_seo_audit_completed'],
    ['trackImageSeoAuditFailed', { errorCode: 'timeout' }, 'image_seo_audit_failed']
  ];
  const skipped = ['tester@qa.oppti.dev', 'x@example.invalid', 'a@maxxspace.com', 'b@UberIP.com'];

  for (const [fn, extra] of paths) {
    test.each(skipped)(`${fn} sends nothing to Loops for %s`, async (email) => {
      const loops = require('../../../src/services/loops');
      await loops[fn]({ email, ...base, ...extra });
      expect(global.fetch).not.toHaveBeenCalled();
    });
  }

  for (const [fn, extra, eventName] of paths) {
    test(`${fn} still creates the lead and sends the event for a normal email`, async () => {
      const loops = require('../../../src/services/loops');
      await loops[fn]({ email: 'owner@realsite.com', ...base, ...extra });
      const urls = global.fetch.mock.calls.map(([u]) => String(u));
      expect(urls.some((u) => u.includes('/contacts/create'))).toBe(true);
      const ev = global.fetch.mock.calls.find(([u]) => String(u).includes('/events/send'));
      expect(ev).toBeTruthy();
      expect(JSON.parse(ev[1].body)).toMatchObject({ email: 'owner@realsite.com', eventName });
    });
  }

  test('upsertAuditLeadContact is guarded on its own', async () => {
    const loops = require('../../../src/services/loops');
    await loops.upsertAuditLeadContact({ email: 'q@qa.oppti.dev', ...base, source: 's' });
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
