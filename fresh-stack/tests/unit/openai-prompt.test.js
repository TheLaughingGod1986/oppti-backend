const { buildPrompt } = require('../../lib/openai');

describe('OpenAI prompt builder', () => {
  test('includes saved style and additional instructions when provided', () => {
    const prompt = buildPrompt({
      title: 'Blue ceramic mug',
      tone: 'E-commerce',
      customPrompt: 'Mention product material when visible.'
    });

    expect(prompt).toContain('Title: Blue ceramic mug');
    expect(prompt).toContain('Requested style: E-commerce');
    expect(prompt).toContain('Additional user instructions: Mention product material when visible.');
  });
});
