const axios = require('axios');
const logger = require('./logger');

const DEFAULT_EXCERPT_CHARS = 8000;
const MAX_SECTIONS = 6;
const MAX_HEADINGS_IN_PROMPT = 40;

const SYSTEM_PROMPT = (
  'You are a content-refresh assistant for WordPress publishers.'
  + ' Given a published page that shows content decay (age, staleness, thin copy,'
  + ' weak headings, or outdated year mentions), propose a minimal, high-quality refresh.'
  + '\n\nRules:'
  + '\n- Keep the brand voice and topic. Do not invent facts, statistics, prices, or quotes.'
  + '\n- Prefer editing what exists over rewriting the whole page.'
  + '\n- Title ≤ 60 characters. Meta description ≤ 160 characters.'
  + '\n- intro_html must be a short HTML paragraph (or two) suitable to replace the first intro block.'
  + '\n- sections: up to 6 items. Each has heading, html (safe HTML: p/ul/ol/li/strong/em/a),'
  + ' action ("add" or "replace"), and optional target_heading for replace.'
  + '\n- last_updated_note: a short plain-text line like "Updated November 2026" when requested.'
  + '\n- rationale: one short sentence explaining the refresh focus for the editor.'
  + '\n- Honour the include_* options: omit fields the editor did not request.'
  + '\n- Return JSON only with this shape:'
  + ' {"suggestions":{"title":"string","meta_description":"string","intro_html":"string",'
  + '"sections":[{"heading":"string","html":"string","action":"add|replace","target_heading":"string"}],'
  + '"last_updated_note":"string","rationale":"string"}}'
);

function truncateExcerpt(value, max = DEFAULT_EXCERPT_CHARS) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

function stripHtml(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function safeHtml(value, max = 4000) {
  if (typeof value !== 'string') return '';
  const cleaned = value.trim();
  if (!cleaned) return '';
  // Allow a conservative subset; the WordPress plugin also runs wp_kses_post.
  const allowed = cleaned
    .replace(/<(?!\/?(?:p|ul|ol|li|strong|em|a|br|h[2-3])(?:\s|>|\/))/gi, '&lt;')
    .slice(0, max);
  return allowed;
}

function buildContentRefreshPrompt({ post = {}, options = {} } = {}) {
  const lines = [
    'Propose a content refresh for this published page.',
    '',
    'POST:'
  ];
  if (post.title) lines.push(`- Title: ${post.title}`);
  if (post.url) lines.push(`- URL: ${post.url}`);
  if (post.published_at) lines.push(`- Published: ${post.published_at}`);
  if (post.modified_at) lines.push(`- Last modified: ${post.modified_at}`);
  if (post.word_count != null) lines.push(`- Word count: ${post.word_count}`);
  if (post.decay_score != null) lines.push(`- Decay score: ${post.decay_score}`);
  if (Array.isArray(post.decay_reasons) && post.decay_reasons.length) {
    lines.push(`- Decay reasons: ${post.decay_reasons.join(', ')}`);
  }
  if (Array.isArray(post.outdated_years) && post.outdated_years.length) {
    lines.push(`- Outdated years mentioned: ${post.outdated_years.join(', ')}`);
  }
  if (post.meta_description) lines.push(`- Current meta: ${String(post.meta_description).slice(0, 300)}`);

  const headings = Array.isArray(post.headings) ? post.headings.slice(0, MAX_HEADINGS_IN_PROMPT) : [];
  if (headings.length) {
    lines.push('- Headings:');
    headings.forEach((h) => {
      const level = h?.level || 2;
      const text = typeof h?.text === 'string' ? h.text : '';
      if (text) lines.push(`  H${level}: ${text}`);
    });
  }

  const excerpt = truncateExcerpt(post.content_excerpt);
  if (excerpt) {
    lines.push('- Content excerpt:');
    lines.push(excerpt);
  }

  lines.push('');
  lines.push('OPTIONS:');
  lines.push(`- include_title_meta: ${options.include_title_meta !== false}`);
  lines.push(`- include_intro: ${options.include_intro !== false}`);
  lines.push(`- include_sections: ${options.include_sections !== false}`);
  lines.push(`- include_last_updated: ${options.include_last_updated !== false}`);
  lines.push('');
  lines.push('Return JSON only.');
  return lines.join('\n');
}

function tryParseJson(payload) {
  try {
    return JSON.parse(payload);
  } catch (_error) {
    return null;
  }
}

function parseSuggestionsResponse(content) {
  if (!content || typeof content !== 'string') return null;
  const direct = tryParseJson(content.trim());
  if (direct) return direct;
  const match = content.match(/\{[\s\S]*\}/);
  return match ? tryParseJson(match[0]) : null;
}

/**
 * Normalise model output into the contract the Content Refresh plugin expects.
 */
function normaliseSuggestions(raw, { options = {} } = {}) {
  const src = (raw && typeof raw === 'object' && raw.suggestions && typeof raw.suggestions === 'object')
    ? raw.suggestions
    : (raw && typeof raw === 'object' ? raw : {});

  const includeTitleMeta = options.include_title_meta !== false;
  const includeIntro = options.include_intro !== false;
  const includeSections = options.include_sections !== false;
  const includeLastUpdated = options.include_last_updated !== false;

  const sections = [];
  if (includeSections && Array.isArray(src.sections)) {
    for (const section of src.sections) {
      if (sections.length >= MAX_SECTIONS) break;
      if (!section || typeof section !== 'object') continue;
      const heading = typeof section.heading === 'string' ? section.heading.trim().slice(0, 200) : '';
      const html = safeHtml(section.html || section.content_html || '', 6000);
      if (!heading && !html) continue;
      const action = String(section.action || 'add').toLowerCase() === 'replace' ? 'replace' : 'add';
      const targetHeading = typeof section.target_heading === 'string'
        ? section.target_heading.trim().slice(0, 200)
        : '';
      sections.push({
        heading: heading || 'Updated section',
        html: html || `<p>${stripHtml(heading)}</p>`,
        action,
        target_heading: action === 'replace' ? targetHeading : ''
      });
    }
  }

  const title = includeTitleMeta && typeof src.title === 'string'
    ? src.title.trim().slice(0, 70)
    : '';
  const metaDescription = includeTitleMeta && typeof src.meta_description === 'string'
    ? src.meta_description.trim().slice(0, 180)
    : (includeTitleMeta && typeof src.metaDescription === 'string'
      ? src.metaDescription.trim().slice(0, 180)
      : '');
  const introHtml = includeIntro
    ? safeHtml(src.intro_html || src.introHtml || '', 3000)
    : '';
  const lastUpdatedNote = includeLastUpdated && typeof (src.last_updated_note || src.lastUpdatedNote) === 'string'
    ? String(src.last_updated_note || src.lastUpdatedNote).trim().slice(0, 120)
    : '';
  const rationale = typeof src.rationale === 'string'
    ? src.rationale.trim().slice(0, 400)
    : '';

  return {
    title,
    meta_description: metaDescription,
    intro_html: introHtml,
    sections,
    last_updated_note: lastUpdatedNote,
    rationale
  };
}

async function generateContentRefreshSuggestions({ post = {}, options = {} } = {}) {
  const apiKey = process.env.ALTTEXT_OPENAI_API_KEY || process.env.OPENAI_API_KEY;
  const preferredModel = process.env.OPENAI_CONTENT_REFRESH_MODEL || process.env.OPENAI_MODEL || 'gpt-4o-mini';
  const fallbackModel = 'gpt-4o-mini';
  let modelUsed = preferredModel;

  if (!apiKey) {
    logger.error('[OpenAI:content-refresh] Missing API key - check OPENAI_API_KEY or ALTTEXT_OPENAI_API_KEY in env');
    const configError = new Error('OpenAI API key is not configured. Set ALTTEXT_OPENAI_API_KEY or OPENAI_API_KEY.');
    configError.code = 'BACKEND_CONFIG_ERROR';
    configError.isRetryable = false;
    throw configError;
  }

  const prompt = buildContentRefreshPrompt({ post, options });
  const tsStart = Date.now();
  const isProdLogging = process.env.NODE_ENV === 'production';

  const requestBody = {
    model: modelUsed,
    temperature: 0.3,
    max_tokens: 1800,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: prompt }
    ]
  };

  logger.info('[OpenAI:content-refresh] refresh_request_started', {
    post_id: post?.id ?? null,
    post_url: post?.url || null,
    word_count: post?.word_count ?? null,
    decay_score: post?.decay_score ?? null,
    model: modelUsed,
    status: 'started'
  });

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
          timeout: 90000
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
            timeout: 90000
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
    const parsed = parseSuggestionsResponse(raw);

    if (!parsed) {
      logger.error('[OpenAI:content-refresh] Could not parse JSON response', isProdLogging
        ? { model: modelUsed, latencyMs, status: 'unparseable_response' }
        : { model: modelUsed, rawPreview: raw.substring(0, 200) });
      const parseError = new Error('OpenAI returned a response that could not be parsed as content refresh suggestions.');
      parseError.code = 'GENERATION_PARSE_ERROR';
      parseError.isRetryable = true;
      throw parseError;
    }

    const suggestions = normaliseSuggestions(parsed, { options });

    logger.info('[OpenAI:content-refresh] refresh_completed', {
      model: modelUsed,
      latencyMs,
      section_count: suggestions.sections.length,
      total_tokens: usage?.total_tokens ?? null,
      status: 'completed'
    });

    return {
      suggestions,
      usage,
      meta_info: {
        modelUsed,
        latencyMs
      }
    };
  } catch (error) {
    if (error.code && (error.code.startsWith('GENERATION_') || error.code === 'BACKEND_CONFIG_ERROR')) {
      throw error;
    }

    const message = error?.response?.data?.error?.message || error.message || 'OpenAI request failed';
    const errorCode = error?.response?.data?.error?.code || error?.response?.status || 'UNKNOWN';
    const httpStatus = error?.response?.status || null;
    const isApiKeyError = /incorrect.*api.*key|invalid.*api.*key|authentication.*failed/i.test(message);
    const isRateLimit = httpStatus === 429;
    const isServerError = httpStatus >= 500;

    logger.error('[OpenAI:content-refresh] Generation failed', isProdLogging
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
  buildContentRefreshPrompt,
  generateContentRefreshSuggestions,
  parseSuggestionsResponse,
  normaliseSuggestions,
  DEFAULT_EXCERPT_CHARS,
  MAX_SECTIONS
};
