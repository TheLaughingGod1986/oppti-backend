const {
  buildCommonProperties,
  captureServerEvent,
  normalizeGenerationMode,
  sanitizePostHogProperties,
  withWebsitePersonProperties
} = require('../../lib/posthog');

describe('PostHog person display properties', () => {
  test('uses the website domain as the person name', () => {
    expect(withWebsitePersonProperties({
      domain: 'shop.example.com',
      site_url: 'https://shop.example.com/'
    })).toEqual({
      domain: 'shop.example.com',
      site_url: 'https://shop.example.com/',
      $set: {
        name: 'shop.example.com',
        website: 'https://shop.example.com/'
      }
    });
  });

  test('preserves explicit person properties', () => {
    expect(withWebsitePersonProperties({
      domain: 'example.com',
      $set: { name: 'Explicit name', plan: 'pro' }
    }).$set).toEqual({
      name: 'Explicit name',
      website: 'example.com',
      plan: 'pro'
    });
  });
});

describe('sanitizePostHogProperties', () => {
  test('removes authentication secrets and email fields recursively', () => {
    expect(sanitizePostHogProperties({
      correlation_id: 'corr-1',
      email: 'person@example.com',
      password: 'secret',
      access_token: 'token',
      nested: {
        session_token: 'session',
        error_code: 'invalid_credentials'
      }
    })).toEqual({
      correlation_id: 'corr-1',
      nested: {
        error_code: 'invalid_credentials'
      }
    });
  });
});

describe('central PostHog analytics properties', () => {
  test('attaches environment, internal, correlation, install, and schema properties', () => {
    expect(buildCommonProperties({
      environment: 'test',
      request_id: 'req-1',
      install_hash: 'install-1',
      plugin_version: '4.7.0'
    })).toEqual(expect.objectContaining({
      environment: 'test',
      is_internal: true,
      correlation_id: 'req-1',
      site_install_id: 'install-1',
      plugin_version: '4.7.0',
      event_schema_version: 2
    }));
  });

  test('uses controlled generation modes', () => {
    expect(normalizeGenerationMode('single')).toBe('single');
    expect(normalizeGenerationMode('bulk')).toBe('bulk');
    expect(normalizeGenerationMode('not-a-mode')).toBe('unknown');
  });

  test('PostHog transport failure resolves safely', async () => {
    const previousKey = process.env.POSTHOG_API_KEY;
    const previousHost = process.env.POSTHOG_HOST;
    const previousFetch = global.fetch;
    process.env.POSTHOG_API_KEY = 'phc_test';
    process.env.POSTHOG_HOST = 'https://posthog.invalid';
    global.fetch = jest.fn().mockRejectedValue(new Error('unavailable'));

    await expect(captureServerEvent({
      event: 'test_event',
      distinctId: 'person-1'
    })).resolves.toEqual(expect.objectContaining({ ok: false }));

    process.env.POSTHOG_API_KEY = previousKey;
    process.env.POSTHOG_HOST = previousHost;
    global.fetch = previousFetch;
  });
});
