/**
 * Install id and PostHog billing payloads.
 * - site_install_id = sha256('oppti-install-v1:' + raw site key), the plugin
 *   formula (fixture shared with Alt Text TelemetryInstallIdHashTest.php).
 * - site_hash in PostHog billing events = sha256(raw), the plugin's prop.
 * - No PostHog request body carries a raw site key, a stored site_hash or a
 *   licence key under ANY key (distinct_id, alias, $set, properties...).
 */
const { installIdFromSiteKey, siteHashForAnalytics, INSTALL_ID_PREFIX } = require('../../lib/installId');

describe('lib/installId', () => {
  test("fixture: sha256('oppti-install-v1:abc')", () => {
    expect(INSTALL_ID_PREFIX).toBe('oppti-install-v1:');
    expect(installIdFromSiteKey('abc')).toBe('ea66c63fec4b39dbfd491e385da2298bb0ad9025189b4de4a6c1944918e0aadb');
    expect(siteHashForAnalytics('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
  test('empty values give null, like the plugin', () => {
    for (const value of [null, undefined, '', '   ', 42]) {
      expect(installIdFromSiteKey(value)).toBeNull();
      expect(siteHashForAnalytics(value)).toBeNull();
    }
  });
});

describe('PostHog billing request bodies carry no replayable value', () => {
  const RAW_SITE_KEY = 'qa-raw-site-key-secret-0001';
  const STORED_SITE_HASH = 'qa0stored0site0hash0abc123';
  const LICENCE_KEY = 'QA-FAKE-LICENSE-KEY-0001';
  let bodies;
  let fetchSpy;
  const env = { ...process.env };

  beforeEach(() => {
    jest.resetModules();
    process.env.POSTHOG_API_KEY = 'phc_test_dummy';
    process.env.POSTHOG_HOST = 'https://posthog.invalid';
    bodies = [];
    fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      bodies.push({ url: String(url), body: init.body });
      return { ok: true, status: 200 };
    });
  });
  afterEach(() => {
    fetchSpy.mockRestore();
    process.env = { ...env };
  });

  const replayable = [RAW_SITE_KEY, STORED_SITE_HASH, LICENCE_KEY];
  function expectNoReplayableValues() {
    expect(bodies.length).toBeGreaterThan(0);
    const all = bodies.map((b) => b.body).join('\n');
    for (const value of replayable) expect(all).not.toContain(value);
  }
  const parsed = () => bodies.map((b) => ({ path: new URL(b.url).pathname, ...JSON.parse(b.body) }));

  async function runAllBillingEvents({ site, distinctId, eventSiteHash }) {
    const { emitCanonicalBillingEvents } = require('../../services/billingTelemetry');
    const common = {
      account_id: 'acct_1',
      license_key: LICENCE_KEY,
      // Old Stripe metadata and old plugins carry the raw key here; new
      // plugins send it hashed. Neither is used for the emitted value.
      site_install_id: RAW_SITE_KEY,
      site_hash: eventSiteHash,
      stripe_customer_id: 'cus_1',
      stripe_subscription_id: 'sub_1',
      plan: 'pro',
      amount: 12.99,
      currency: 'gbp'
    };
    const account = { id: 'acct_1', license_key: LICENCE_KEY, plan: 'pro' };
    const metadata = { site_install_id: RAW_SITE_KEY, site_hash: RAW_SITE_KEY, siteKey: RAW_SITE_KEY, license_key: LICENCE_KEY };
    // checkout + legacy payment_succeeded (+ alias and identify)
    await emitCanonicalBillingEvents({
      stripeEventId: 'evt_checkout_1', stripeEventType: 'checkout.session.completed', distinctId,
      includeLegacyPaymentSucceeded: true,
      eventProperties: { ...common, payment_mode: 'subscription', checkout_session_id: 'cs_1' },
      metadata, site, account
    });
    // renewal
    await emitCanonicalBillingEvents({
      stripeEventId: 'evt_renew_1', stripeEventType: 'invoice.paid', distinctId,
      eventProperties: { ...common, billing_reason: 'subscription_cycle' },
      metadata, site, account
    });
  }

  test.each([
    ['account distinct id, stored site_hash = raw key', { site: { id: 'site_1', site_hash: RAW_SITE_KEY }, distinctId: 'acct_1', eventSiteHash: RAW_SITE_KEY }, RAW_SITE_KEY],
    ['site-key distinct id fallback', { site: { id: 'site_1', site_hash: RAW_SITE_KEY }, distinctId: RAW_SITE_KEY, eventSiteHash: RAW_SITE_KEY }, RAW_SITE_KEY],
    ['licence-key distinct id', { site: { id: 'site_1', site_hash: RAW_SITE_KEY }, distinctId: LICENCE_KEY, eventSiteHash: RAW_SITE_KEY }, RAW_SITE_KEY],
    ['stored site_hash differs from the key in the event', { site: { id: 'site_1', site_hash: STORED_SITE_HASH }, distinctId: STORED_SITE_HASH, eventSiteHash: RAW_SITE_KEY }, STORED_SITE_HASH]
  ])('payment_succeeded, subscription_renewed, alias and identify: %s', async (_label, input, rawForInstallId) => {
    await runAllBillingEvents(input);
    const sent = parsed();
    const events = sent.map((b) => b.event || b.path);
    expect(events).toEqual(expect.arrayContaining(['checkout_completed', 'payment_succeeded', 'subscription_renewed', '$create_alias', '/identify/']));
    expectNoReplayableValues();

    const installId = installIdFromSiteKey(rawForInstallId);
    const payment = sent.find((b) => b.event === 'payment_succeeded');
    expect(payment.properties.site_install_id).toBe(installId);
    const renewed = sent.find((b) => b.event === 'subscription_renewed');
    expect(renewed.properties.site_install_id).toBe(installId);
    expect(renewed.properties.site_hash).toBe(siteHashForAnalytics(rawForInstallId));
    const alias = sent.find((b) => b.event === '$create_alias');
    expect(alias.distinct_id).toBe('acct_1');
    expect(alias.properties.alias).toBe(installId);
    const identify = sent.find((b) => b.path === '/identify/');
    expect(identify.distinct_id).toBe('acct_1');
    for (const body of sent.filter((b) => b.event && b.event !== '$create_alias')) {
      expect(['acct_1', installId]).toContain(body.distinct_id);
    }
  });

  test('a raw or an already-hashed client site_install_id (4.6.143 / 4.6.144) gives the same single-hashed value', async () => {
    const { buildCanonicalProperties } = require('../../services/billingTelemetry');
    const site = { id: 'site_1', site_hash: RAW_SITE_KEY };
    const oldPlugin = buildCanonicalProperties({ eventProperties: { site_install_id: RAW_SITE_KEY }, site, stripeEventId: 'evt_a', canonicalEvent: 'checkout_completed' });
    const newPlugin = buildCanonicalProperties({ eventProperties: { site_install_id: installIdFromSiteKey(RAW_SITE_KEY) }, site, stripeEventId: 'evt_b', canonicalEvent: 'checkout_completed' });
    expect(oldPlugin.site_install_id).toBe(installIdFromSiteKey(RAW_SITE_KEY));
    expect(newPlugin.site_install_id).toBe(oldPlugin.site_install_id);
    expect(newPlugin.site_install_id).not.toBe(installIdFromSiteKey(installIdFromSiteKey(RAW_SITE_KEY)));
  });

  test('customer health events use the hashed install id as distinct id and site_install_id', async () => {
    const path = require('path');
    const fs = require('fs');
    const source = fs.readFileSync(path.resolve(__dirname, '../../services/customerHealthTelemetry.js'), 'utf8');
    expect(source).toMatch(/installIdFromSiteKey\(site\.site_hash\)/);
    expect(source).not.toMatch(/distinctId = site\.site_hash/);
    expect(source).not.toMatch(/site_install_id: site\.site_hash/);
  });
});

describe('plugin telemetry context: X-Telemetry-Install-ID is hashed before it leaves', () => {
  const { pluginTelemetryContext } = require('../../lib/pluginTelemetryContext');
  const RAW = 'qa_raw_site_key_secret_0001';
  const req = (body) => ({
    body,
    user: { id: 'acct-1' },
    header: (name) => ({ 'X-Telemetry-Consent': 'yes', 'X-Telemetry-Install-ID': RAW, 'X-Environment': 'production' })[name]
  });
  test('4.6.143 (raw body id) and 4.6.144 (hashed body id) requests give the same single-hashed id', () => {
    const oldCtx = pluginTelemetryContext(req({ site_install_id: RAW }), { pluginSlug: 'p', product: 'alt_text', operationId: 'op' });
    const newCtx = pluginTelemetryContext(req({ site_install_id: installIdFromSiteKey(RAW) }), { pluginSlug: 'p', product: 'alt_text', operationId: 'op' });
    expect(oldCtx.site_install_id).toBe(installIdFromSiteKey(RAW));
    expect(newCtx.site_install_id).toBe(oldCtx.site_install_id);
    expect(JSON.stringify(oldCtx)).not.toContain(RAW);
  });
});
