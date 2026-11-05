const {
  buildContentRefreshPrompt,
  parseSuggestionsResponse,
  normaliseSuggestions
} = require('../../lib/openaiContentRefresh');

describe('openaiContentRefresh helpers', () => {
  test('builds a prompt with decay context and options', () => {
    const prompt = buildContentRefreshPrompt({
      post: {
        title: 'Old Guide',
        url: 'https://example.test/old',
        content_excerpt: 'Tips from 2018 that still matter.',
        decay_score: 72,
        decay_reasons: ['age', 'stale'],
        outdated_years: [2018],
        headings: [{ level: 2, text: 'Intro' }]
      },
      options: { include_intro: true, include_sections: false }
    });
    expect(prompt).toContain('Old Guide');
    expect(prompt).toContain('Decay score: 72');
    expect(prompt).toContain('2018');
    expect(prompt).toContain('include_sections: false');
  });

  test('parses JSON even when wrapped in prose', () => {
    const parsed = parseSuggestionsResponse('Here you go:\n{"suggestions":{"title":"Fresh"}}\n');
    expect(parsed.suggestions.title).toBe('Fresh');
  });

  test('normalises sections and respects include flags', () => {
    const out = normaliseSuggestions({
      suggestions: {
        title: 'A'.repeat(80),
        meta_description: 'Meta',
        intro_html: '<p>Hello</p>',
        sections: [
          { heading: 'New', html: '<p>Body</p>', action: 'add' },
          { heading: 'Replace me', html: '<p>X</p>', action: 'replace', target_heading: 'Old' }
        ],
        last_updated_note: 'Updated November 2026',
        rationale: 'Refresh outdated years'
      }
    }, { options: { include_title_meta: true, include_intro: true, include_sections: true, include_last_updated: true } });

    expect(out.title.length).toBeLessThanOrEqual(70);
    expect(out.meta_description).toBe('Meta');
    expect(out.intro_html).toContain('Hello');
    expect(out.sections).toHaveLength(2);
    expect(out.sections[1].action).toBe('replace');
    expect(out.sections[1].target_heading).toBe('Old');
    expect(out.last_updated_note).toContain('2026');
  });

  test('omits fields when options disable them', () => {
    const out = normaliseSuggestions({
      title: 'Keep?',
      intro_html: '<p>Nope</p>',
      sections: [{ heading: 'X', html: '<p>Y</p>' }],
      last_updated_note: 'Updated'
    }, { options: { include_title_meta: false, include_intro: false, include_sections: false, include_last_updated: false } });

    expect(out.title).toBe('');
    expect(out.intro_html).toBe('');
    expect(out.sections).toEqual([]);
    expect(out.last_updated_note).toBe('');
  });
});
