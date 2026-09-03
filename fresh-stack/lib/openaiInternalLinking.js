const axios = require('axios');
const logger = require('./logger');

const DEFAULT_MAX_SUGGESTIONS = 5;
const MAX_SUGGESTIONS_CAP = 10;
const DEFAULT_SOURCE_EXCERPT_CHARS = 4000;
const MAX_CANDIDATES = 60;

const SYSTEM_PROMPT = (
  'You are an internal-linking assistant for a website.'
  + ' Given one SOURCE page and a numbered list of CANDIDATE pages on the same site,'
  + ' decide which candidates the source page should link to, and pick a natural anchor phrase.'
  + '\n\nRules:'
  + '\n- Only suggest a link when the candidate is genuinely topically relevant to the source.'
  + '\n- Prefer an anchor phrase that already appears verbatim in the source content; put that exact'
  + ' substring in "phrase" so it can be linked without rewriting the page. If no good phrase exists,'
  + ' still give a short natural "anchor" and set "phrase" to the same text.'
  + '\n- Never suggest linking a page to itself.'
  + '\n- Give a short, concrete "reason" (why the link helps the reader) and a 0-100 "score" confidence.'
  + '\n- It is fine to return fewer suggestions than requested, or none, if nothing is relevant.'
  + '\n- Return JSON only: {"suggestions":[{"target_index":number,"anchor":string,"phrase":string,'
  + '"reason":string,"score":number}]}'
);

function truncateExcerpt(value, max = DEFAULT_SOURCE_EXCERPT_CHARS) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

function clampScore(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function buildInternalLinkingPrompt({ source = {}, candidates = [], options = {} } = {}) {
  const maxSuggestions = Math.min(options.max_suggestions || DEFAULT_MAX_SUGGESTIONS, MAX_SUGGESTIONS_CAP);
  const lines = [
    `Suggest up to ${maxSuggestions} internal links FROM the source page TO the most relevant candidates.`,
    '',
    'SOURCE page:'
  ];

  if (source.title) lines.push(`- Title: ${source.title}`);
  if (source.url) lines.push(`- URL: ${source.url}`);
  const excerpt = truncateExcerpt(source.content_excerpt);
  if (excerpt) {
    lines.push('- Content:');
    lines.push(excerpt);
  }

  lines.push('');
  lines.push('CANDIDATE pages (use the number as "target_index"):');
  candidates.forEach((candidate, index) => {
    const title = candidate.title || candidate.url || `Candidate ${index}`;
    lines.push(`${index}. ${title}${candidate.url ? ` — ${candidate.url}` : ''}`);
  });

  lines.push('');
  lines.push('Return JSON only: {"suggestions":[{"target_index":0,"anchor":"...","phrase":"...","reason":"...","score":80}]}');
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
 * Normalise the model's raw suggestions against the candidate list: resolve
 * target_index to a real candidate, drop self-links and duplicates, coerce the
 * score, and keep only the fields the plugin needs to review and apply a link.
 */
function normaliseSuggestions(rawSuggestions, { source, candidates, maxSuggestions }) {
  if (!Array.isArray(rawSuggestions)) return [];
  const out = [];
  const seen = new Set();

  for (const raw of rawSuggestions) {
    if (out.length >= maxSuggestions) break;
    if (!raw || typeof raw !== 'object') continue;

    const index = Number(raw.target_index);
    if (!Number.isInteger(index) || index < 0 || index >= candidates.length) continue;

    const candidate = candidates[index];
    if (!candidate) continue;
    // Never link a page to itself.
    if (source.id != null && candidate.id != null && String(source.id) === String(candidate.id)) continue;
    if (source.url && candidate.url && source.url === candidate.url) continue;
    if (seen.has(index)) continue;
    seen.add(index);

    const anchor = typeof raw.anchor === 'string' ? raw.anchor.trim() : '';
    const phrase = typeof raw.phrase === 'string' && raw.phrase.trim() ? raw.phrase.trim() : anchor;
    if (!anchor && !phrase) continue;

    out.push({
      target_index: index,
      target_id: candidate.id ?? null,
      target_url: candidate.url ?? null,
      target_title: candidate.title ?? null,
      anchor: anchor || phrase,
      phrase,
      reason: typeof raw.reason === 'string' ? raw.reason.trim().slice(0, 300) : '',
      score: clampScore(raw.score)
    });
  }

  return out;
}

async function generateInternalLinkSuggestions({ source, candidates = [], options = {} } = {}) {
  const apiKey = process.env.ALTTEXT_OPENAI_API_KEY || process.env.OPENAI_API_KEY;
  const preferredModel = process.env.OPENAI_LINKING_MODEL || process.env.OPENAI_MODEL || 'gpt-4o-mini';
  const fallbackModel = 'gpt-4o-mini';
  let modelUsed = preferredModel;

  if (!apiKey) {
    logger.error('[OpenAI:linking] Missing API key - check OPENAI_API_KEY or ALTTEXT_OPENAI_API_KEY in env');
    const configError = new Error('OpenAI API key is not configured. Set ALTTEXT_OPENAI_API_KEY or OPENAI_API_KEY.');
    configError.code = 'BACKEND_CONFIG_ERROR';
    configError.isRetryable = false;
    throw configError;
  }

  const trimmedCandidates = candidates.slice(0, MAX_CANDIDATES);
  const maxSuggestions = Math.min(options.max_suggestions || DEFAULT_MAX_SUGGESTIONS, MAX_SUGGESTIONS_CAP);
  const prompt = buildInternalLinkingPrompt({ source, candidates: trimmedCandidates, options });
  const tsStart = Date.now();
  const isProdLogging = process.env.NODE_ENV === 'production';

  const requestBody = {
    model: modelUsed,
    temperature: 0.2,
    max_tokens: 700,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: prompt }
    ]
  };

  logger.info('[OpenAI:linking] linking_request_started', {
    source_url: source?.url || null,
    candidate_count: trimmedCandidates.length,
    max_suggestions: maxSuggestions,
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
    const parsed = parseSuggestionsResponse(raw);

    if (!parsed || !Array.isArray(parsed.suggestions)) {
      logger.error('[OpenAI:linking] Could not parse JSON response', isProdLogging
        ? { model: modelUsed, latencyMs, status: 'unparseable_response' }
        : { model: modelUsed, rawPreview: raw.substring(0, 200) });
      const parseError = new Error('OpenAI returned a response that could not be parsed as link suggestions.');
      parseError.code = 'GENERATION_PARSE_ERROR';
      parseError.isRetryable = true;
      throw parseError;
    }

    const suggestions = normaliseSuggestions(parsed.suggestions, {
      source: source || {},
      candidates: trimmedCandidates,
      maxSuggestions
    });

    logger.info('[OpenAI:linking] linking_completed', {
      model: modelUsed,
      latencyMs,
      suggestion_count: suggestions.length,
      total_tokens: usage?.total_tokens ?? null,
      status: 'completed'
    });

    return {
      suggestions,
      usage,
      meta_info: {
        modelUsed,
        latencyMs,
        candidate_count: trimmedCandidates.length
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
  buildInternalLinkingPrompt,
  generateInternalLinkSuggestions,
  parseSuggestionsResponse,
  normaliseSuggestions,
  DEFAULT_MAX_SUGGESTIONS,
  MAX_SUGGESTIONS_CAP
};
