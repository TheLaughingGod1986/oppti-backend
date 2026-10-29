/**
 * Licence keys never reach PostHog, whatever the spelling and however deep a
 * caller nests them, and the outbound distinct_id and $create_alias value are
 * never a raw site key, stored site_hash or licence key, for 4.6.143-shaped
 * (raw body site_install_id) and 4.6.144-shaped (hashed) plugin input.
 */
const express = require('express');
const request = require('supertest');
const { installIdFromSiteKey } = require('../../lib/installId');

const LICENCE = 'QA-FAKE-LICENSE-KEY-0001';
const RAW_SITE_KEY = 'qa-raw-site-key-secret-0001';

describe('lib/posthog licence strip', () => {
  const { stripSiteIdentifiers } = require('../../lib/posthog');

  test.each([
    'license_key', 'licenseKey', 'licence_key', 'licenceKey', 'license-key', 'licence-key',
    'License_Key', 'LICENSE_KEY', 'LicenceKey', 'license key', 'x_license_key', 'site_licence_key', 'licenseKeyPrefix'
  ])('drops %s at the top level and in $set/$set_once', (key) => {
    const cleaned = stripSiteIdentifiers({ plan: 'pro', [key]: LICENCE, $set: { plan: 'pro', [key]: LICENCE }, $set_once: { [key]: LICENCE, tier: 'a' } });
    expect(cleaned).toEqual({ plan: 'pro', $set: { plan: 'pro' }, $set_once: { tier: 'a' } });
    expect(JSON.stringify(cleaned)).not.toContain(LICENCE);
  });

  test('nested objects at any depth never carry a licence key out', () => {
    const deep = { a: { b: { c: { d: { licence_key: LICENCE, plan: 'pro' } } } } };
    const cleaned = stripSiteIdentifiers({
      plan: 'pro',
      meta: deep,
      rows: [{ licenseKey: LICENCE }],
      $set: { plan: 'pro', account: { billing: { 'license-key': LICENCE } } },
      $set_once: { nested: [{ deeper: { LicenceKey: LICENCE } }] }
    });
    expect(JSON.stringify(cleaned)).not.toContain(LICENCE);
    expect(cleaned).toEqual({ plan: 'pro', $set: { plan: 'pro' } });
  });
});

describe('outbound PostHog bodies: distinct_id and alias value', () => {
  let bodies;
  let fetchSpy;
  const env = { ...process.env };
  beforeEach(() => {
    jest.resetModules();
    process.env.POSTHOG_API_KEY = 'phc_test_dummy';
    process.env.POSTHOG_HOST = 'https://posthog.invalid';
    bodies = [];
    fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      bodies.push(JSON.parse(init.body));
      return { ok: true, status: 200 };
    });
  });
  afterEach(() => { fetchSpy.mockRestore(); process.env = { ...env }; });

  test('capture and identify strip every licence spelling, nested too', async () => {
    const { captureServerEvent, identifyServerUser } = require('../../lib/posthog');
    await captureServerEvent({ event: 'x_event', distinctId: 'acct_1', properties: { licenceKey: LICENCE, 'license-key': LICENCE, meta: { deep: { licence_key: LICENCE } } } });
    await identifyServerUser({ distinctId: 'acct_1', properties: { $set: { LICENCE_KEY: LICENCE, nested: { license_key: LICENCE } } } });
    expect(bodies).toHaveLength(2);
    expect(JSON.stringify(bodies)).not.toContain(LICENCE);
  });

  test.each([
    ['4.6.143 (raw body site_install_id)', RAW_SITE_KEY],
    ['4.6.144 (hashed body site_install_id)', installIdFromSiteKey(RAW_SITE_KEY)]
  ])('%s: distinct_id is the account or hashed install id and the alias value is the hashed install id', async (_label, bodyInstallId) => {
    const { emitCanonicalBillingEvents } = require('../../services/billingTelemetry');
    const site = { id: 'site_1', site_hash: RAW_SITE_KEY };
    const account = { id: 'acct_1', license_key: LICENCE };
    const eventProperties = { account_id: 'acct_1', license_key: LICENCE, licenceKey: LICENCE, site_install_id: bodyInstallId, site_hash: RAW_SITE_KEY, plan: 'pro', amount: 12.99, currency: 'gbp', payment_mode: 'subscription', checkout_session_id: 'cs_1' };
    for (const distinctId of ['acct_1', RAW_SITE_KEY, LICENCE]) {
      await emitCanonicalBillingEvents({
        stripeEventId: `evt_${distinctId.length}`, stripeEventType: 'checkout.session.completed', distinctId,
        includeLegacyPaymentSucceeded: true, eventProperties,
        metadata: { site_install_id: bodyInstallId, site_hash: RAW_SITE_KEY, license_key: LICENCE }, site, account
      });
    }
    const installId = installIdFromSiteKey(RAW_SITE_KEY);
    const serialized = JSON.stringify(bodies);
    expect(serialized).not.toContain(RAW_SITE_KEY);
    expect(serialized).not.toContain(LICENCE);
    const aliases = bodies.filter((b) => b.event === '$create_alias');
    expect(aliases.length).toBeGreaterThan(0);
    for (const alias of aliases) {
      expect(alias.distinct_id).toBe('acct_1');
      expect(alias.properties.alias).toBe(installId);
    }
    for (const body of bodies) {
      expect(['acct_1', installId]).toContain(body.distinct_id);
    }
  });
});

describe('/analytics/event pass-through goes through the same strip', () => {
  function makeApp(capture) {
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => { req.user = { id: 'acct-1' }; next(); });
    const { createAnalyticsRouter } = require('../../routes/analytics');
    app.use('/analytics', createAnalyticsRouter({ capture }));
    return app;
  }

  test('a capture function that skips lib/posthog still never receives a licence key or site key', async () => {
    const capture = jest.fn().mockResolvedValue({ ok: true, status: 200 });
    const res = await request(makeApp(capture)).post('/analytics/event').send({
      event: 'cta_clicked',
      properties: { cta: 'upgrade', license_key: LICENCE, licenceKey: LICENCE, 'license-key': LICENCE, site_hash: RAW_SITE_KEY, meta: { deep: { licence_key: LICENCE } } }
    });
    expect(res.status).toBe(200);
    expect(capture).toHaveBeenCalledTimes(1);
    const sent = JSON.stringify(capture.mock.calls[0][0]);
    expect(sent).not.toContain(LICENCE);
    expect(sent).not.toContain(RAW_SITE_KEY);
  });

  test('routes/analytics.js passes the properties through stripSiteIdentifiers', () => {
    const source = require('fs').readFileSync(require('path').resolve(__dirname, '../../routes/analytics.js'), 'utf8');
    expect(source).toMatch(/properties: stripSiteIdentifiers\(\{/);
  });
});
