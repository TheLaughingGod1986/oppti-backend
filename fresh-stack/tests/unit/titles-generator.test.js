jest.mock('axios', () => ({
  post: jest.fn()
}));

const axios = require('axios');
const { generateTitleAndMeta } = require('../../lib/openaiTitles');

describe('generateTitleAndMeta', () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.OPENAI_API_KEY = 'sk-test';
    delete process.env.ALTTEXT_OPENAI_API_KEY;
    delete process.env.OPENAI_TITLES_MODEL;
    delete process.env.OPENAI_MODEL;
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  test('parses a clean JSON response and returns title + meta + usage', async () => {
    axios.post.mockResolvedValueOnce({
      data: {
        choices: [
          {
            message: {
              content: JSON.stringify({
                title: 'The 2026 SEO Guide: Title Tags, Meta, and Schema',
                meta: 'How modern title and meta description writing works post-AI overviews.'
              })
            }
          }
        ],
        usage: { prompt_tokens: 200, completion_tokens: 40, total_tokens: 240 }
      }
    });

    const result = await generateTitleAndMeta({
      page: { url: '/x', h1: 'The 2026 SEO Guide' },
      options: { brand_name: 'X' }
    });

    expect(axios.post).toHaveBeenCalledTimes(1);
    const [, body] = axios.post.mock.calls[0];
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(body.messages[0].role).toBe('system');
    expect(result.title).toContain('2026 SEO Guide');
    expect(result.meta.length).toBeGreaterThan(0);
    expect(result.usage.total_tokens).toBe(240);
    expect(result.meta_info.modelUsed).toBeTruthy();
    expect(result.meta_info.regenerated).toBe(false);
  });

  test('returns regenerated: true when previous is supplied', async () => {
    axios.post.mockResolvedValueOnce({
      data: {
        choices: [{ message: { content: '{"title":"Fresh","meta":"Different angle"}' } }],
        usage: { total_tokens: 100 }
      }
    });

    const result = await generateTitleAndMeta({
      page: { url: '/x' },
      previous: { title: 'Old', meta: 'Old meta' }
    });
    expect(result.meta_info.regenerated).toBe(true);
  });

  test('throws BACKEND_CONFIG_ERROR when API key is missing', async () => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.ALTTEXT_OPENAI_API_KEY;
    await expect(generateTitleAndMeta({ page: { url: '/x' } })).rejects.toMatchObject({
      code: 'BACKEND_CONFIG_ERROR'
    });
  });

  test('throws GENERATION_PARSE_ERROR when the response is not JSON-parseable', async () => {
    axios.post.mockResolvedValueOnce({
      data: { choices: [{ message: { content: 'sorry, I cannot help with that.' } }] }
    });
    await expect(generateTitleAndMeta({ page: { url: '/x' } })).rejects.toMatchObject({
      code: 'GENERATION_PARSE_ERROR'
    });
  });

  test('maps rate-limit and server errors to typed codes', async () => {
    axios.post.mockRejectedValueOnce({ response: { status: 429, data: { error: { message: 'Too many requests' } } } });
    await expect(generateTitleAndMeta({ page: { url: '/x' } })).rejects.toMatchObject({
      code: 'UPSTREAM_RATE_LIMITED',
      isRetryable: true
    });

    axios.post.mockRejectedValueOnce({ response: { status: 503, data: { error: { message: 'gateway' } } } });
    await expect(generateTitleAndMeta({ page: { url: '/x' } })).rejects.toMatchObject({
      code: 'UPSTREAM_GENERATION_ERROR',
      isRetryable: true
    });
  });

  test('falls back to gpt-4o-mini when preferred model returns "model does not exist"', async () => {
    process.env.OPENAI_TITLES_MODEL = 'gpt-9999-test-only';
    axios.post.mockRejectedValueOnce({
      response: { status: 400, data: { error: { message: 'The model gpt-9999-test-only does not exist' } } }
    });
    axios.post.mockResolvedValueOnce({
      data: {
        choices: [{ message: { content: '{"title":"OK","meta":"OK meta description here"}' } }],
        usage: { total_tokens: 100 }
      }
    });

    const result = await generateTitleAndMeta({ page: { url: '/x' } });
    expect(axios.post).toHaveBeenCalledTimes(2);
    expect(axios.post.mock.calls[1][1].model).toBe('gpt-4o-mini');
    expect(result.meta_info.modelUsed).toBe('gpt-4o-mini');
  });

  test('clamps overly long titles/metas to the configured max', async () => {
    const longTitle = 't'.repeat(200);
    const longMeta = 'm'.repeat(500);
    axios.post.mockResolvedValueOnce({
      data: {
        choices: [{ message: { content: JSON.stringify({ title: longTitle, meta: longMeta }) } }],
        usage: { total_tokens: 100 }
      }
    });
    const result = await generateTitleAndMeta({
      page: { url: '/x' },
      options: { title_max_chars: 60, meta_max_chars: 160 }
    });
    expect(result.title.length).toBeLessThanOrEqual(60);
    expect(result.meta.length).toBeLessThanOrEqual(160);
  });
});
