const { buildTitlesPrompt } = require('../../lib/openaiTitles');

describe('Titles prompt builder', () => {
  test('includes URL, H1, content excerpt, brand and tone when provided', () => {
    const prompt = buildTitlesPrompt({
      page: {
        url: '/blog/seo-2026',
        section: 'Blog',
        h1: 'The 2026 SEO Guide',
        content_excerpt: 'How modern title and meta description writing works.'
      },
      options: { brand_name: 'Mission Coffee', tone: 'professional' }
    });

    expect(prompt).toContain('- URL: /blog/seo-2026');
    expect(prompt).toContain('- Section: Blog');
    expect(prompt).toContain('- H1: The 2026 SEO Guide');
    expect(prompt).toContain('How modern title and meta description writing works.');
    expect(prompt).toContain('Brand: Mission Coffee');
    expect(prompt).toContain('Tone: professional');
    expect(prompt).toContain('Return JSON only');
  });

  test('honors title_max_chars and meta_max_chars overrides in the directive line', () => {
    const prompt = buildTitlesPrompt({
      page: { url: '/x' },
      options: { title_max_chars: 80, meta_max_chars: 200 }
    });
    expect(prompt).toMatch(/title \(≤80 chars\)/);
    expect(prompt).toMatch(/meta description \(≤200 chars\)/);
  });

  test('adds regeneration directives when previous title/meta is supplied', () => {
    const prompt = buildTitlesPrompt({
      page: { url: '/about', h1: 'About' },
      options: {},
      previous: { title: 'About Mission Coffee', meta: 'Hand-roasted coffee since 2018.' }
    });

    expect(prompt).toContain('This is a regeneration');
    expect(prompt).toContain('Previous title (do not repeat phrasing): About Mission Coffee');
    expect(prompt).toContain('Previous meta (do not repeat phrasing): Hand-roasted coffee since 2018.');
  });

  test('skips the regeneration block when previous is null or empty', () => {
    const prompt = buildTitlesPrompt({
      page: { url: '/x', h1: 'X' },
      options: {},
      previous: null
    });
    expect(prompt).not.toContain('This is a regeneration');

    const emptyPrev = buildTitlesPrompt({
      page: { url: '/x', h1: 'X' },
      options: {},
      previous: {}
    });
    expect(emptyPrev).not.toContain('This is a regeneration');
  });

  test('truncates long content excerpts', () => {
    const longText = 'a'.repeat(10_000);
    const prompt = buildTitlesPrompt({
      page: { url: '/x', content_excerpt: longText },
      options: {}
    });
    // Default cap is 4000 chars + ellipsis.
    expect(prompt).toContain('…');
    const excerptLine = prompt.split('- Content excerpt:')[1] || '';
    expect(excerptLine.length).toBeLessThan(longText.length);
  });
});
