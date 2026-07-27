const {
  isStoryUrl,
  normalizePagePath,
} = require('../../../scripts/kit-looker-utils');

describe('kit-looker-utils', () => {
  test('normalizePagePath strips host and trailing slash', () => {
    expect(normalizePagePath('https://www.service95.com/travel-beauty-products/')).toBe(
      '/travel-beauty-products',
    );
  });

  test('normalizePagePath rejects non-service95 URLs', () => {
    expect(normalizePagePath('https://www.youtube.com/c/service95')).toBe('');
    expect(normalizePagePath('mailto:test@example.com')).toBe('');
  });

  test('isStoryUrl keeps article links and drops utility pages', () => {
    expect(isStoryUrl('https://www.service95.com/grassroots-football-community')).toBe(true);
    expect(isStoryUrl('https://www.service95.com/privacy-policy/')).toBe(false);
    expect(isStoryUrl('https://www.tiktok.com/@service95')).toBe(false);
  });
});
