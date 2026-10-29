const { stripSiteIdentifiers, captureServerEvent, identifyServerUser } = require('../../lib/posthog');

describe('PostHog site identifier stripping', () => {
  test('removes site URL, domain and host keys from event properties', () => {
    expect(stripSiteIdentifiers({
      site_install_id: 'install-abcdef1234567890',
      site_url: 'https://shop.example.com/',
      domain: 'shop.example.com',
      host: 'shop.example.com',
      site_host: 'shop.example.com',
      plan: 'free'
    })).toEqual({
      site_install_id: 'install-abcdef1234567890',
      plan: 'free'
    });
  });

  test('never derives person name or website from the site', () => {
    const cleaned = stripSiteIdentifiers({
      domain: 'shop.example.com',
      site_url: 'https://shop.example.com/'
    });
    expect(cleaned.$set).toBeUndefined();
  });

  test('keeps explicit non-site person properties and drops site ones', () => {
    expect(stripSiteIdentifiers({
      $set: { plan: 'pro', website: 'https://example.com', domain: 'example.com' }
    }).$set).toEqual({ plan: 'pro' });
  });

  test('drops nested objects (meta.site_url) and arrays of objects; keeps flat values and scalar arrays', () => {
    expect(stripSiteIdentifiers({
      plan: 'pro',
      count: 3,
      ok: true,
      none: null,
      tags: ['a', 'b'],
      meta: { site_url: 'https://shop.customer-brand.co.uk' },
      rows: [{ email: 'qa-person@example.invalid' }],
      $set: { plan: 'pro', profile: { email: 'qa-person@example.invalid' } }
    })).toEqual({ plan: 'pro', count: 3, ok: true, none: null, tags: ['a', 'b'], $set: { plan: 'pro' } });
  });

  test('drops email, licence key, attribution URLs and free text anywhere; person name and address too', () => {
    const cleaned = stripSiteIdentifiers({
      email: 'qa-person@example.invalid',
      license_key: 'QA-FAKE-LICENSE-KEY-0001',
      referrer: 'https://shop.customer-brand.co.uk/wp-admin/',
      landing_page: 'https://shop.customer-brand.co.uk/pricing',
      source_page: 'https://shop.customer-brand.co.uk/wp-admin/upload.php',
      plan: 'free',
      $set: {
        name: 'shop.customer-brand.co.uk',
        email: 'qa-person@example.invalid',
        address: '1 High Street',
        signup_source_other: 'my agency told me',
        signup_source: 'other'
      },
      $set_once: { license_key: 'QA-FAKE-LICENSE-KEY-0001', first_name: 'Jane' }
    });
    expect(cleaned).toEqual({ plan: 'free', $set: { signup_source: 'other' } });
  });

  describe('outbound payloads', () => {
    const originalFetch = global.fetch;
    const originalEnv = { key: process.env.POSTHOG_API_KEY, host: process.env.POSTHOG_HOST };
    let bodies;

    beforeEach(() => {
      bodies = [];
      process.env.POSTHOG_API_KEY = 'phc_test_placeholder';
      process.env.POSTHOG_HOST = 'http://127.0.0.1:9';
      global.fetch = jest.fn(async (_url, init) => {
        bodies.push(JSON.parse(init.body));
        return { ok: true, status: 200 };
      });
    });

    afterEach(() => {
      global.fetch = originalFetch;
      if (originalEnv.key === undefined) delete process.env.POSTHOG_API_KEY; else process.env.POSTHOG_API_KEY = originalEnv.key;
      if (originalEnv.host === undefined) delete process.env.POSTHOG_HOST; else process.env.POSTHOG_HOST = originalEnv.host;
    });

    test('capture sends no site identifiers or $set.website', async () => {
      await captureServerEvent({
        event: 'generation_completed',
        distinctId: 'install-abcdef1234567890',
        properties: { site_url: 'https://a.example.com/', domain: 'a.example.com', host: 'a.example.com', plan: 'free' }
      });
      expect(bodies).toHaveLength(1);
      expect(bodies[0].properties).toEqual({ plan: 'free' });
      expect(JSON.stringify(bodies[0])).not.toContain('a.example.com');
    });

    test('identify sends no site identifiers', async () => {
      await identifyServerUser({
        distinctId: 'acct-1',
        properties: { $set: { website: 'https://a.example.com/', signup_source: 'search' } }
      });
      expect(bodies[0].properties).toEqual({ $set: { signup_source: 'search' } });
    });

    test('identify omits null and undefined values so stored person properties are not overwritten', async () => {
      await identifyServerUser({
        distinctId: 'acct-1',
        properties: {
          plan: 'pro',
          stripe_customer_id: null,
          stripe_subscription_id: undefined,
          site_install_id: null,
          $set: { signup_source: 'search', signup_source_plugin: null },
          $set_once: { first_plan: null }
        }
      });
      expect(bodies[0].properties).toEqual({ plan: 'pro', $set: { signup_source: 'search' } });
      expect(JSON.stringify(bodies[0])).not.toContain('null');
    });
  });
});
