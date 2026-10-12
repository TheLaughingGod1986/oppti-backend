const axios = require('axios');
const logger = require('./logger');

const DEFAULT_CONTENT_EXCERPT_CHARS = 2500;
const DEFAULT_MAX_SUGGESTIONS = 8;
const HARD_MAX_SUGGESTIONS = 20;

const SYSTEM_PROMPT = (
  'You are an SEO internal-linking assistant for a WordPress site.'
  + ' Suggest high-quality internal links from source pages to under-linked target pages.'
  + ' Return JSON only with the shape {"suggestions":[{"sourcePageId":string,"targetPageId":string,"anchorText":string,"insertionContext":string,"score":number}]}.'
  + '\n\nRules:'
  + '\n- Only use page ids provided in the request. Never invent pages.'
  + '\n- Prefer topical relevance over volume. Skip weak matches.'
  + '\n- anchorText must be a short natural phrase (2–6 words) that already appears in insertionContext, or a close paraphrase of a phrase that appears there.'
  + '\n- insertionContext must be a short verbatim snippet (one sentence or clause) copied from the source page content_excerpt where the link should be placed.'
  + '\n- Do not suggest linking a page to itself.'
  + '\n- Do not suggest links that would invent facts. Prefer descriptive anchors over "click here".'
  + '\n- score is 0–100 (higher = stronger topical match).'
);

function clampString(value, max) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  return trimmed.length > max ? trimmed.slice(0, max).trim() : trimmed;
}

function truncateExcerpt(value, max = DEFAULT_CONTENT_EXCERPT_CHARS) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

function normalizePageList(pages = [], { requireExcerpt = false } = {}) {
  if (!Array.isArray(pages)) return [];
  return pages
    .map((page) => {
      const id = page?.id != null ? String(page.id) : null;
      if (!id) return null;
      const excerpt = truncateExcerpt(page.content_excerpt || page.contentExcerpt || '');
      if (requireExcerpt && !excerpt) return null;
      return {
        id,
        title: clampString(page.title || '', 200) || null,
        url: clampString(page.url || '', 2048) || null,
        outbound: Number.isFinite(Number(page.outbound)) ? Number(page.outbound) : null,
        inbound: Number.isFinite(Number(page.inbound)) ? Number(page.inbound) : null,
        content_excerpt: excerpt
      };
    })
    .filter(Boolean);
}

function buildLinkingPrompt({ targets = [], sources = [], maxSuggestions = DEFAULT_MAX_SUGGESTIONS } = {}) {
  const lines = [
    `Suggest up to ${maxSuggestions} internal links from source pages to target pages.`,
    'Each suggestion must help readers discover an under-linked target from a relevant source.',
    '',
    'Target pages (need inbound links):'
  ];

  targets.forEach((page, index) => {
    lines.push(`${index + 1}. id=${page.id}`);
    if (page.title) lines.push(`   title: ${page.title}`);
    if (page.url) lines.push(`   url: ${page.url}`);
    if (page.inbound != null) lines.push(`   inbound: ${page.inbound}`);
    if (page.content_excerpt) {
      lines.push('   excerpt:');
      lines.push(page.content_excerpt);
    }
  });

  lines.push('');
  lines.push('Source candidate pages (can host new outbound links):');
  sources.forEach((page, index) => {
    lines.push(`${index + 1}. id=${page.id}`);
    if (page.title) lines.push(`   title: ${page.title}`);
    if (page.url) lines.push(`   url: ${page.url}`);
    if (page.outbound != null) lines.push(`   outbound: ${page.outbound}`);
    if (page.content_excerpt) {
      lines.push('   excerpt:');
      lines.push(page.content_excerpt);
    }
  });

  lines.push('');
  lines.push(`Return JSON only: {"suggestions":[{"sourcePageId":"...","targetPageId":"...","anchorText":"...","insertionContext":"...","score":80}]}`);
  lines.push(`Return at most ${maxSuggestions} suggestions. If none are strong, return {"suggestions":[]}.`);
  return lines.join('\n');
}

function tryParseJson(payload) {
  try {
    return JSON.parse(payload);
  } catch (_error) {
    return null;
  }
}

function parseLinkingResponse(content) {
  if (!content || typeof content !== 'string') return null;
  const direct = tryParseJson(content.trim());
  if (direct) return direct;
  const match = content.match(/\{[\s\S]*\}/);
  return match ? tryParseJson(match[0]) : null;
}

function sanitizeSuggestions(rawSuggestions, { targets, sources, maxSuggestions }) {
  const targetIds = new Set(targets.map((p) => p.id));
  const sourceIds = new Set(sources.map((p) => p.id));
  const seen = new Set();
  const out = [];

  const list = Array.isArray(rawSuggestions) ? rawSuggestions : [];
  for (const item of list) {
    if (out.length >= maxSuggestions) break;
    const sourcePageId = item?.sourcePageId != null ? String(item.sourcePageId) : null;
    const targetPageId = item?.targetPageId != null ? String(item.targetPageId) : null;
    const anchorText = clampString(item?.anchorText || '', 80);
    const insertionContext = clampString(item?.insertionContext || '', 400);
    if (!sourcePageId || !targetPageId || !anchorText || !insertionContext) continue;
    if (!sourceIds.has(sourcePageId) || !targetIds.has(targetPageId)) continue;
    if (sourcePageId === targetPageId) continue;

    const key = `${sourcePageId}->${targetPageId}:${anchorText.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const scoreRaw = Number(item?.score);
    const score = Number.isFinite(scoreRaw)
      ? Math.max(0, Math.min(100, Math.round(scoreRaw)))
      : null;

    out.push({
      sourcePageId,
      targetPageId,
      anchorText,
      insertionContext,
      score
    });
  }

  return out;
}

async function generateInternalLinkSuggestions({
  targets = [],
  sources = [],
  maxSuggestions = DEFAULT_MAX_SUGGESTIONS
} = {}) {
  const apiKey = process.env.ALTTEXT_OPENAI_API_KEY || process.env.OPENAI_API_KEY;
  const preferredModel = process.env.OPENAI_LINKING_MODEL || process.env.OPENAI_TITLES_MODEL || process.env.OPENAI_MODEL || 'gpt-4o-mini';
  const fallbackModel = 'gpt-4o-mini';
  let modelUsed = preferredModel;

  const cappedMax = Math.max(1, Math.min(
    HARD_MAX_SUGGESTIONS,
    Number.isFinite(Number(maxSuggestions)) ? Math.floor(Number(maxSuggestions)) : DEFAULT_MAX_SUGGESTIONS
  ));

  const normalizedTargets = normalizePageList(targets);
  const normalizedSources = normalizePageList(sources, { requireExcerpt: true });

  if (!normalizedTargets.length) {
    const err = new Error('At least one target page is required.');
    err.code = 'INVALID_REQUEST';
    err.isRetryable = false;
    throw err;
  }
  if (!normalizedSources.length) {
    const err = new Error('At least one source page with content is required.');
    err.code = 'INVALID_REQUEST';
    err.isRetryable = false;
    throw err;
  }

  if (!apiKey) {
    logger.error('[OpenAI:linking] Missing API key - check OPENAI_API_KEY or ALTTEXT_OPENAI_API_KEY in env');
    const configError = new Error('OpenAI API key is not configured. Set ALTTEXT_OPENAI_API_KEY or OPENAI_API_KEY.');
    configError.code = 'BACKEND_CONFIG_ERROR';
    configError.isRetryable = false;
    throw configError;
  }

  const prompt = buildLinkingPrompt({
    targets: normalizedTargets,
    sources: normalizedSources,
    maxSuggestions: cappedMax
  });
  const tsStart = Date.now();
  const isProdLogging = process.env.NODE_ENV === 'production';

  const requestBody = {
    model: modelUsed,
    temperature: 0.3,
    max_tokens: 1200,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: prompt }
    ]
  };

  logger.info('[OpenAI:linking] linking_request_started', isProdLogging
    ? { model: modelUsed, targets: normalizedTargets.length, sources: normalizedSources.length, status: 'started' }
    : {
      model: modelUsed,
      targets: normalizedTargets.length,
      sources: normalizedSources.length,
      maxSuggestions: cappedMax
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
    const parsed = parseLinkingResponse(raw);

    if (!parsed || !Array.isArray(parsed.suggestions)) {
      logger.error('[OpenAI:linking] Could not parse JSON response', isProdLogging
        ? { model: modelUsed, latencyMs, status: 'unparseable_response' }
        : { model: modelUsed, rawPreview: raw.substring(0, 200) });
      const parseError = new Error('OpenAI returned a response that could not be parsed as linking suggestions JSON.');
      parseError.code = 'GENERATION_PARSE_ERROR';
      parseError.isRetryable = true;
      throw parseError;
    }

    const suggestions = sanitizeSuggestions(parsed.suggestions, {
      targets: normalizedTargets,
      sources: normalizedSources,
      maxSuggestions: cappedMax
    });

    logger.info('[OpenAI:linking] linking_completed', {
      model: modelUsed,
      latencyMs,
      suggestionCount: suggestions.length,
      promptTokens: usage?.prompt_tokens ?? null,
      completionTokens: usage?.completion_tokens ?? null,
      totalTokens: usage?.total_tokens ?? null,
      status: 'completed'
    });

    return {
      suggestions,
      usage,
      meta_info: {
        modelUsed,
        latencyMs,
        maxSuggestions: cappedMax,
        targetCount: normalizedTargets.length,
        sourceCount: normalizedSources.length
      }
    };
  } catch (error) {
    if (error.code && (error.code.startsWith('GENERATION_') || error.code === 'INVALID_REQUEST' || error.code === 'BACKEND_CONFIG_ERROR')) {
      throw error;
    }

    const message = error?.response?.data?.error?.message || error.message || 'OpenAI request failed';
    const errorCode = error?.response?.data?.error?.code || error?.response?.status || 'UNKNOWN';
    const httpStatus = error?.response?.status || null;
    const isApiKeyError = /incorrect.*api.*key|invalid.*api.*key|authentication.*failed/i.test(message);
    const isRateLimit = httpStatus === 429;
    const isServerError = httpStatus >= 500;

    logger.error('[OpenAI:linking] Generation failed', isProdLogging
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
  buildLinkingPrompt,
  generateInternalLinkSuggestions,
  parseLinkingResponse,
  sanitizeSuggestions,
  DEFAULT_MAX_SUGGESTIONS,
  HARD_MAX_SUGGESTIONS
};
