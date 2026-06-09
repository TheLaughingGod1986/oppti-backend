const axios = require('axios');
const logger = require('./logger');

const DEFAULT_TITLE_MAX_CHARS = 60;
const DEFAULT_META_MAX_CHARS = 160;
const DEFAULT_CONTENT_EXCERPT_CHARS = 4000;

const SYSTEM_PROMPT = (
  'You are an SEO copywriter writing title tags and meta descriptions for individual web pages.'
  + ' For each page, write exactly one title tag and one meta description.'
  + ' Return JSON with the shape {"title": string, "meta": string} and nothing else.'
  + '\n\nGuidelines:'
  + '\n- Title: ≤ 60 characters, primary keyword in the first 40 characters, optional brand suffix only if it fits.'
  + '\n- Meta description: ≤ 160 characters, includes a tangible benefit and a clear next step or context. No clickbait.'
  + '\n- Tone: match the requested tone if provided; otherwise neutral, plain-English, no marketing fluff.'
  + '\n- Never repeat the URL or H1 verbatim — paraphrase and improve.'
  + '\n- Do not invent facts, prices, or quotes that are not present in the page content.'
);

function clampString(value, max) {
  if (typeof value !== 'string') return value;
  return value.length > max ? value.slice(0, max).trim() : value.trim();
}

function truncateExcerpt(value, max = DEFAULT_CONTENT_EXCERPT_CHARS) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

function buildTitlesPrompt({ page = {}, options = {}, previous = null } = {}) {
  const titleMax = options.title_max_chars || DEFAULT_TITLE_MAX_CHARS;
  const metaMax = options.meta_max_chars || DEFAULT_META_MAX_CHARS;
  const lines = [
    `Write a title (≤${titleMax} chars) and meta description (≤${metaMax} chars) for this page.`,
    '',
    'Page:'
  ];

  if (page.url) lines.push(`- URL: ${page.url}`);
  if (page.section) lines.push(`- Section: ${page.section}`);
  if (page.h1) lines.push(`- H1: ${page.h1}`);
  if (page.current_title) lines.push(`- Existing title: ${page.current_title}`);
  if (page.current_meta) lines.push(`- Existing meta: ${page.current_meta}`);

  const excerpt = truncateExcerpt(page.content_excerpt);
  if (excerpt) {
    lines.push('- Content excerpt:');
    lines.push(excerpt);
  }

  if (options.brand_name || options.tone) {
    lines.push('');
    lines.push('Style:');
    if (options.brand_name) lines.push(`- Brand: ${options.brand_name}`);
    if (options.tone) lines.push(`- Tone: ${options.tone}`);
  }

  if (previous && (previous.title || previous.meta)) {
    lines.push('');
    lines.push('This is a regeneration. Produce a distinctly different angle and phrasing.');
    if (previous.title) lines.push(`Previous title (do not repeat phrasing): ${previous.title}`);
    if (previous.meta) lines.push(`Previous meta (do not repeat phrasing): ${previous.meta}`);
  }

  lines.push('');
  lines.push('Return JSON only: {"title": "...", "meta": "..."}');
  return lines.join('\n');
}

function tryParseJson(payload) {
  try {
    return JSON.parse(payload);
  } catch (_error) {
    return null;
  }
}

function parseTitlesResponse(content) {
  if (!content || typeof content !== 'string') return null;
  const direct = tryParseJson(content.trim());
  if (direct) return direct;
  const match = content.match(/\{[\s\S]*\}/);
  return match ? tryParseJson(match[0]) : null;
}

async function generateTitleAndMeta({ page, options = {}, previous = null } = {}) {
  const apiKey = process.env.ALTTEXT_OPENAI_API_KEY || process.env.OPENAI_API_KEY;
  const preferredModel = process.env.OPENAI_TITLES_MODEL || process.env.OPENAI_MODEL || 'gpt-4o-mini';
  const fallbackModel = 'gpt-4o-mini';
  let modelUsed = preferredModel;

  if (!apiKey) {
    logger.error('[OpenAI:titles] Missing API key - check OPENAI_API_KEY or ALTTEXT_OPENAI_API_KEY in env');
    const configError = new Error('OpenAI API key is not configured. Set ALTTEXT_OPENAI_API_KEY or OPENAI_API_KEY.');
    configError.code = 'BACKEND_CONFIG_ERROR';
    configError.isRetryable = false;
    throw configError;
  }

  const prompt = buildTitlesPrompt({ page, options, previous });
  const tsStart = Date.now();
  const isProdLogging = process.env.NODE_ENV === 'production';

  const titleMax = options.title_max_chars || DEFAULT_TITLE_MAX_CHARS;
  const metaMax = options.meta_max_chars || DEFAULT_META_MAX_CHARS;

  const requestBody = {
    model: modelUsed,
    temperature: 0.4,
    max_tokens: 220,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: prompt }
    ]
  };

  if (!isProdLogging) {
    logger.info('[OpenAI:titles] Generation request prepared', {
      url: page?.url || null,
      hasH1: Boolean(page?.h1),
      excerptLength: page?.content_excerpt ? page.content_excerpt.length : 0,
      regenerate: Boolean(previous && (previous.title || previous.meta)),
      model: modelUsed
    });
  } else {
    logger.info('[OpenAI:titles] titles_request_started', {
      model: modelUsed,
      regenerate: Boolean(previous),
      status: 'started'
    });
  }

  try {
    let response;
    try {
      response = await axios.post(
        'https://api.openai.com/v1/chat/completions',
        requestBody,
        {
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
          },
          timeout: 60000
        }
      );
    } catch (firstError) {
      const msg = firstError?.response?.data?.error?.message || '';
      const modelMissing = /model.+does not exist/i.test(msg) || /You must provide a model parameter/.test(msg);
      if (modelMissing && modelUsed !== fallbackModel) {
        modelUsed = fallbackModel;
        response = await axios.post(
          'https://api.openai.com/v1/chat/completions',
          { ...requestBody, model: modelUsed },
          {
            headers: {
              Authorization: `Bearer ${apiKey}`,
              'Content-Type': 'application/json'
            },
            timeout: 60000
          }
        );
      } else {
        throw firstError;
      }
    }

    const choice = response.data?.choices?.[0];
    const raw = choice?.message?.content?.trim() || '';
    const usage = response.data?.usage || null;
    const latencyMs = Date.now() - tsStart;
    const parsed = parseTitlesResponse(raw);

    if (!parsed || typeof parsed.title !== 'string' || typeof parsed.meta !== 'string') {
      logger.error('[OpenAI:titles] Could not parse JSON response', isProdLogging
        ? { model: modelUsed, latencyMs, status: 'unparseable_response' }
        : { model: modelUsed, rawPreview: raw.substring(0, 200) });
      const parseError = new Error('OpenAI returned a response that could not be parsed as title/meta JSON.');
      parseError.code = 'GENERATION_PARSE_ERROR';
      parseError.isRetryable = true;
      throw parseError;
    }

    const title = clampString(parsed.title, titleMax);
    const meta = clampString(parsed.meta, metaMax);

    if (!title || !meta) {
      const emptyError = new Error('OpenAI returned empty title or meta description.');
      emptyError.code = 'GENERATION_EMPTY';
      emptyError.isRetryable = true;
      throw emptyError;
    }

    logger.info('[OpenAI:titles] titles_completed', isProdLogging
      ? {
        model: modelUsed,
        latencyMs,
        promptTokens: usage?.prompt_tokens ?? null,
        completionTokens: usage?.completion_tokens ?? null,
        totalTokens: usage?.total_tokens ?? null,
        title_length: title.length,
        meta_length: meta.length,
        status: 'completed'
      }
      : {
        model: modelUsed,
        latencyMs,
        titlePreview: title.substring(0, 40),
        metaPreview: meta.substring(0, 60)
      });

    return {
      title,
      meta,
      usage,
      meta_info: {
        modelUsed,
        regenerated: Boolean(previous && (previous.title || previous.meta)),
        latencyMs
      }
    };
  } catch (error) {
    if (error.code && error.code.startsWith('GENERATION_')) {
      throw error;
    }

    const message = error?.response?.data?.error?.message || error.message || 'OpenAI request failed';
    const errorCode = error?.response?.data?.error?.code || error?.response?.status || 'UNKNOWN';
    const httpStatus = error?.response?.status || null;
    const isApiKeyError = /incorrect.*api.*key|invalid.*api.*key|authentication.*failed/i.test(message);
    const isRateLimit = httpStatus === 429;
    const isServerError = httpStatus >= 500;

    logger.error('[OpenAI:titles] Generation failed', isProdLogging
      ? { code: errorCode, status: httpStatus, model: modelUsed, isApiKeyError, isRateLimit, isServerError }
      : { error: message, code: errorCode, status: httpStatus, model: modelUsed });

    const genError = new Error(message);
    genError.code = isApiKeyError ? 'BACKEND_CONFIG_ERROR'
      : isRateLimit ? 'UPSTREAM_RATE_LIMITED'
      : isServerError ? 'UPSTREAM_GENERATION_ERROR'
      : 'GENERATION_FAILED';
    genError.httpStatus = httpStatus;
    genError.isRetryable = isRateLimit || isServerError;
    throw genError;
  }
}

module.exports = {
  buildTitlesPrompt,
  generateTitleAndMeta,
  parseTitlesResponse,
  DEFAULT_TITLE_MAX_CHARS,
  DEFAULT_META_MAX_CHARS
};
