const {
  buildInternalLinkingPrompt,
  parseSuggestionsResponse,
  normaliseSuggestions
} = require('../../lib/openaiInternalLinking');

describe('openaiInternalLinking helpers', () => {
  describe('buildInternalLinkingPrompt', () => {
    test('lists candidates with their index and includes source content', () => {
      const prompt = buildInternalLinkingPrompt({
        source: { url: '/a', title: 'A', content_excerpt: 'hello world' },
        candidates: [
          { url: '/b', title: 'B' },
          { url: '/c', title: 'C' }
        ],
        options: { max_suggestions: 3 }
      });
      expect(prompt).toContain('0. B — /b');
      expect(prompt).toContain('1. C — /c');
      expect(prompt).toContain('hello world');
      expect(prompt).toContain('up to 3 internal links');
    });
  });

  describe('parseSuggestionsResponse', () => {
    test('parses a clean JSON object', () => {
      const parsed = parseSuggestionsResponse('{"suggestions":[{"target_index":0}]}');
      expect(parsed.suggestions).toHaveLength(1);
    });

    test('extracts JSON embedded in surrounding text', () => {
      const parsed = parseSuggestionsResponse('Here you go:\n{"suggestions":[]}\nThanks');
      expect(parsed.suggestions).toEqual([]);
    });

    test('returns null for non-JSON', () => {
      expect(parseSuggestionsResponse('not json')).toBeNull();
    });
  });

  describe('normaliseSuggestions', () => {
    const source = { id: 1, url: '/source' };
    const candidates = [
      { id: 2, url: '/two', title: 'Two' },
      { id: 3, url: '/three', title: 'Three' },
      { id: 1, url: '/source', title: 'Self' } // index 2 == source
    ];

    test('resolves target_index to a candidate and keeps needed fields', () => {
      const out = normaliseSuggestions(
        [{ target_index: 0, anchor: 'two', phrase: 'two', reason: 'r', score: 90 }],
        { source, candidates, maxSuggestions: 5 }
      );
      expect(out).toHaveLength(1);
      expect(out[0]).toMatchObject({ target_id: 2, target_url: '/two', anchor: 'two', score: 90 });
    });

    test('drops self-links, out-of-range indices, and duplicates; clamps score', () => {
      const out = normaliseSuggestions(
        [
          { target_index: 2, anchor: 'self', phrase: 'self', score: 50 }, // self-link → drop
          { target_index: 9, anchor: 'nope', phrase: 'nope', score: 50 }, // out of range → drop
          { target_index: 0, anchor: 'two', phrase: 'two', score: 150 }, // clamp to 100
          { target_index: 0, anchor: 'dup', phrase: 'dup', score: 80 } // duplicate index → drop
        ],
        { source, candidates, maxSuggestions: 5 }
      );
      expect(out).toHaveLength(1);
      expect(out[0].target_id).toBe(2);
      expect(out[0].score).toBe(100);
    });

    test('respects maxSuggestions', () => {
      const many = [
        { target_index: 0, anchor: 'a', phrase: 'a', score: 10 },
        { target_index: 1, anchor: 'b', phrase: 'b', score: 20 }
      ];
      const out = normaliseSuggestions(many, { source, candidates, maxSuggestions: 1 });
      expect(out).toHaveLength(1);
    });
  });
});
