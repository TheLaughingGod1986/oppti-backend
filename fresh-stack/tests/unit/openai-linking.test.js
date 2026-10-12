const {
  parseLinkingResponse,
  sanitizeSuggestions,
  buildLinkingPrompt
} = require('../../lib/openaiLinking');

describe('openaiLinking helpers', () => {
  test('parseLinkingResponse extracts JSON object', () => {
    const parsed = parseLinkingResponse('Here you go:\n{"suggestions":[]}\n');
    expect(parsed).toEqual({ suggestions: [] });
  });

  test('sanitizeSuggestions drops invalid / duplicate / self links', () => {
    const out = sanitizeSuggestions([
      { sourcePageId: '1', targetPageId: '2', anchorText: 'hello', insertionContext: 'Say hello now.', score: 90 },
      { sourcePageId: '1', targetPageId: '2', anchorText: 'hello', insertionContext: 'Say hello now.', score: 80 },
      { sourcePageId: '1', targetPageId: '1', anchorText: 'self', insertionContext: 'self link', score: 50 },
      { sourcePageId: '99', targetPageId: '2', anchorText: 'nope', insertionContext: 'missing source', score: 70 },
      { sourcePageId: '1', targetPageId: '2', anchorText: '', insertionContext: 'empty anchor', score: 70 }
    ], {
      targets: [{ id: '2' }],
      sources: [{ id: '1' }],
      maxSuggestions: 5
    });

    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      sourcePageId: '1',
      targetPageId: '2',
      anchorText: 'hello',
      score: 90
    });
  });

  test('buildLinkingPrompt includes targets and sources', () => {
    const prompt = buildLinkingPrompt({
      targets: [{ id: '2', title: 'Orphan', content_excerpt: 'Target text' }],
      sources: [{ id: '1', title: 'Home', content_excerpt: 'Source text' }],
      maxSuggestions: 3
    });
    expect(prompt).toContain('id=2');
    expect(prompt).toContain('id=1');
    expect(prompt).toContain('up to 3');
  });
});
