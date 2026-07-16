const { withWebsitePersonProperties } = require('../../lib/posthog');

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
