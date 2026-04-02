const axios = require('axios');

function buildPrompt(context = {}) {
  const lines = [
    'Write clear, descriptive alt text that accurately describes what the image IS and shows. Focus on accessibility and SEO.',
    '',
    'Guidelines:',
    '- Length: 8-16 words, ideally under 125 characters (optimal for Google Images SEO)',
    '- Describe WHAT the image is: What type (photo, illustration, screenshot, diagram, meme, etc.)? What does it show?',
    '- Include key elements: Main subjects, actions, setting, colors, and any important text visible in the image',
    '- Be specific and factual: Describe what is actually visible, not implied meaning',
    '- Use natural language: Write conversationally, as if describing the image to someone who cannot see it',
    '- Context awareness: If provided, incorporate relevant keywords from title, caption, or page context naturally',
    '- Important text: Include any visible text verbatim (quotes, labels, headlines, etc.)',
    '- Avoid redundancy: Never use "image of" or "picture of" - just describe what it is',
    '',
    'Examples:',
    '- Good: "Aerial view of downtown Chicago skyline at sunset with Lake Michigan in foreground"',
    '- Good: "Screenshot of mobile app interface showing login form with email and password fields"',
    '- Good: "Group photo of five colleagues at a conference table reviewing documents"',
    '- Avoid: "Image of a city" or "Picture showing people"',
  ];

  const hints = [];
  if (context.title) hints.push(`Title: ${context.title}`);
  if (context.caption) hints.push(`Caption: ${context.caption}`);
  if (context.pageTitle) hints.push(`Page: ${context.pageTitle}`);
  if (context.filename) hints.push(`File: ${context.filename}`);
  if (context.altTextSuggestion) hints.push(`User suggestion: ${context.altTextSuggestion}`);

  if (hints.length) {
    lines.push('');
    lines.push('Additional context (use to inform description but focus on what the image actually shows):');
    lines.push(...hints);
  }

  lines.push('');
  lines.push('Return only the alt text description, nothing else.');
  return lines.join('\n');
}

async function generateAltText({ image, context }) {
  const apiKey = process.env.ALTTEXT_OPENAI_API_KEY || process.env.OPENAI_API_KEY;
  // Prefer a vision-capable model; fall back to gpt-4o-mini if not available.
  const preferredModel = process.env.OPENAI_MODEL || 'gpt-4o';
  const fallbackModel = 'gpt-4o-mini';
  let modelUsed = preferredModel;

  const prompt = buildPrompt(context);
  const imageUrl = image.base64
    ? `data:${image.mime_type};base64,${image.base64}`
    : image.url;

  // Enhanced logging for debugging image processing
  const logger = require('./logger');
  logger.info('[OpenAI] Image processing details', {
    hasBase64: !!image.base64,
    hasUrl: !!image.url,
    imageSource: image.base64 ? 'base64' : (image.url ? 'url' : 'none'),
    base64Preview: image.base64 ? image.base64.substring(0, 100) + '...' : null,
    base64Length: image.base64 ? image.base64.length : 0,
    imageUrl: image.url || null,
    imageUrlPreview: image.url ? image.url.substring(0, 100) + '...' : null,
    dimensions: image.width && image.height ? `${image.width}x${image.height}` : 'unknown',
    mimeType: image.mime_type || 'unknown',
    filename: image.filename || 'unknown',
    dataUrlPreview: imageUrl ? imageUrl.substring(0, 150) + '...' : null,
    dataUrlLength: imageUrl ? imageUrl.length : 0,
    dataUrlStartsWith: imageUrl ? imageUrl.substring(0, 30) : null
  });
  
  // CRITICAL: Verify we're using the correct image source
  if (image.base64 && image.url) {
    logger.warn('[OpenAI] WARNING: Both base64 and URL provided - base64 will be used, URL ignored', {
      base64Length: image.base64.length,
      url: image.url
    });
  }
  
  if (!image.base64 && !image.url) {
    logger.error('[OpenAI] ERROR: No image data provided - neither base64 nor URL');
  }

  if (!apiKey) {
    logger.error('[OpenAI] Missing API key - check OPENAI_API_KEY or ALTTEXT_OPENAI_API_KEY in .env.local');
    const configError = new Error('OpenAI API key is not configured. Set ALTTEXT_OPENAI_API_KEY or OPENAI_API_KEY.');
    configError.code = 'BACKEND_CONFIG_ERROR';
    configError.isRetryable = false;
    throw configError;
  }
  
  // Log API key status (first few chars only for security)
  logger.debug('[OpenAI] Using API key', { 
    keyPrefix: apiKey.substring(0, 10) + '...',
    keyLength: apiKey.length,
    model: preferredModel
  });

  try {
    let response;
    try {
      response = await axios.post(
        'https://api.openai.com/v1/chat/completions',
        {
          model: modelUsed,
          temperature: 0.2,
          max_tokens: 75,
          messages: [
            { role: 'system', content: 'You are an expert accessibility and SEO specialist who writes clear, descriptive alt text. Your alt text helps visually impaired users understand images and improves SEO. Always describe what the image IS and what it actually shows, using natural, conversational language.' },
            {
              role: 'user',
              content: [
                { type: 'text', text: prompt },
                { type: 'image_url', image_url: { url: imageUrl, detail: 'auto' } }
              ]
            }
          ]
        },
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
          {
            model: modelUsed,
            temperature: 0.2,
            max_tokens: 75,
            messages: [
              { role: 'system', content: 'You are an accessibility assistant that writes excellent alternative text.' },
              {
                role: 'user',
                content: [
                  { type: 'text', text: prompt },
                  { type: 'image_url', image_url: { url: imageUrl, detail: 'auto' } }
                ]
              }
            ]
          },
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
    const altText = choice?.message?.content?.trim();

    // Log the full response for debugging
    logger.info('[OpenAI] Raw AI response received', {
      model: modelUsed,
      fullResponse: JSON.stringify(response.data),
      choiceContent: choice?.message?.content,
      usage: response.data?.usage,
      imageSourceUsed: image.base64 ? 'base64' : (image.url ? 'url' : 'none')
    });

    if (altText) {
      logger.info('[OpenAI] Alt text generated', { 
        model: modelUsed,
        altTextLength: altText.length,
        altTextPreview: altText.substring(0, 50) + (altText.length > 50 ? '...' : '')
      });
    } else {
      logger.error('[OpenAI] Empty alt text response', { 
        model: modelUsed,
        response: JSON.stringify(response.data).substring(0, 200)
      });
    }

    return {
      altText: altText || fallbackAltText(context),
      usage: response.data?.usage || null,
      meta: { usedFallback: !altText || modelUsed === fallbackModel, modelUsed }
    };
  } catch (error) {
    const message = error?.response?.data?.error?.message || error.message || 'OpenAI request failed';
    const errorCode = error?.response?.data?.error?.code || error?.response?.status || 'UNKNOWN';
    const httpStatus = error?.response?.status || null;
    const isApiKeyError = /incorrect.*api.*key|invalid.*api.*key|authentication.*failed/i.test(message);
    const isRateLimit = httpStatus === 429;
    const isServerError = httpStatus >= 500;

    logger.error('[OpenAI] Alt text generation failed', {
      error: message,
      code: errorCode,
      status: httpStatus,
      model: modelUsed,
      hasApiKey: !!apiKey,
      apiKeyPrefix: apiKey ? apiKey.substring(0, 10) + '...' : 'missing',
      isApiKeyError,
      isRateLimit,
      isServerError
    });

    if (isApiKeyError) {
      logger.error('[OpenAI] CRITICAL: Invalid or missing OpenAI API key. Please check your .env.local file and ensure OPENAI_API_KEY is set correctly.');
    }

    // Throw a structured error so callers can decide how to handle it.
    // Previously this silently returned fallback text, which burned trial
    // credits on placeholder text and masked upstream failures.
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

function fallbackAltText(context = {}) {
  const base = context.title || context.caption || context.pageTitle || 'Image';
  return `${base}: concise descriptive alt text placeholder`;
}

function getReviewApiKey(service = 'alttext-ai') {
  if (service === 'seo-ai-meta') {
    return process.env.OPENAI_REVIEW_API_KEY
      || process.env.SEO_META_OPENAI_API_KEY
      || process.env.OPENAI_API_KEY
      || null;
  }

  return process.env.OPENAI_REVIEW_API_KEY
    || process.env.ALTTEXT_OPENAI_API_KEY
    || process.env.OPENAI_API_KEY
    || null;
}

function buildReviewPrompt(altText, image = {}, context = {}) {
  const lines = [
    'Evaluate whether the provided alternative text accurately describes the attached image.',
    'Respond only with a JSON object with keys: score, status, grade, summary, issues.',
    'Use score as an integer from 0 to 100.',
    'Use status as one of: great, good, review, critical.',
    'Keep summary under 120 characters.',
    `Alt text candidate: "${altText}".`
  ];

  if (image.title) lines.push(`Media title: ${image.title}`);
  if (image.caption) lines.push(`Caption: ${image.caption}`);
  if (image.filename) lines.push(`Filename: ${image.filename}`);
  if (image.width && image.height) lines.push(`Dimensions: ${image.width}x${image.height}px`);
  if (context.title) lines.push(`Page title: ${context.title}`);
  if (context.pageTitle) lines.push(`Page title: ${context.pageTitle}`);
  if (context.post_title) lines.push(`Page title: ${context.post_title}`);
  if (context.caption) lines.push(`Page caption: ${context.caption}`);

  return lines.join('\n');
}

function tryParseJson(payload) {
  try {
    return JSON.parse(payload);
  } catch (_error) {
    return null;
  }
}

function parseReviewResponse(content) {
  if (!content || typeof content !== 'string') {
    return null;
  }

  const direct = tryParseJson(content.trim());
  if (direct) {
    return direct;
  }

  const match = content.match(/\{[\s\S]*\}/);
  return match ? tryParseJson(match[0]) : null;
}

function clampScore(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return null;
  }

  return Math.min(100, Math.max(0, Math.round(numeric)));
}

function normalizeReviewStatus(status, score) {
  const lookup = {
    great: 'great',
    excellent: 'great',
    good: 'good',
    ok: 'review',
    needs_review: 'review',
    review: 'review',
    poor: 'critical',
    critical: 'critical',
    fail: 'critical'
  };

  if (typeof status === 'string') {
    const key = status.toLowerCase().replace(/[^a-z]/g, '_');
    if (lookup[key]) {
      return lookup[key];
    }
  }

  if (typeof score === 'number' && Number.isFinite(score)) {
    if (score >= 90) return 'great';
    if (score >= 75) return 'good';
    if (score >= 55) return 'review';
    return 'critical';
  }

  return 'review';
}

function gradeFromStatus(status) {
  switch (status) {
    case 'great':
      return 'Excellent';
    case 'good':
      return 'Strong';
    case 'review':
      return 'Needs review';
    default:
      return 'Critical';
  }
}

function shouldSkipReviewForImageError(error) {
  const status = error?.response?.status;
  const message = error?.response?.data?.error?.message || error?.message || '';

  if (!status) {
    return false;
  }

  return (status === 400 || status === 422)
    && /image_url|unable to load image|failed to download image|fetch/i.test(message);
}

async function reviewAltText({ altText, image = null, context = {}, service = 'alttext-ai' }) {
  if (!altText || typeof altText !== 'string') {
    return null;
  }

  const base64Data = image?.base64 || image?.image_base64 || null;
  const hasUsableUrl = typeof image?.url === 'string' && /^https:\/\//i.test(image.url);
  const imageUrl = base64Data
    ? `data:${image?.mime_type || 'image/jpeg'};base64,${base64Data}`
    : (hasUsableUrl ? image.url : null);

  if (!imageUrl) {
    return null;
  }

  const apiKey = getReviewApiKey(service);
  if (!apiKey) {
    const configError = new Error('OpenAI review API key is not configured.');
    configError.code = 'BACKEND_CONFIG_ERROR';
    configError.httpStatus = 500;
    throw configError;
  }

  const model = process.env.OPENAI_REVIEW_MODEL || process.env.OPENAI_MODEL || 'gpt-4o-mini';
  const prompt = buildReviewPrompt(altText, image, context);
  const logger = require('./logger');

  try {
    const response = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model,
        temperature: 0,
        max_tokens: 220,
        messages: [
          {
            role: 'system',
            content: 'You are an accessibility QA reviewer. Evaluate how accurately candidate alt text matches the attached image. Return valid JSON only.'
          },
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              { type: 'image_url', image_url: { url: imageUrl, detail: 'auto' } }
            ]
          }
        ]
      },
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        timeout: 60000
      }
    );

    const content = response.data?.choices?.[0]?.message?.content?.trim() || '';
    const parsed = parseReviewResponse(content);

    logger.info('[OpenAI] Review response received', {
      model,
      imageSource: base64Data ? 'base64' : 'url',
      parsed: Boolean(parsed)
    });

    if (!parsed) {
      return null;
    }

    const score = clampScore(parsed.score);
    const status = normalizeReviewStatus(parsed.status, score);
    const issues = Array.isArray(parsed.issues)
      ? parsed.issues
          .filter((item) => typeof item === 'string' && item.trim() !== '')
          .map((item) => item.trim())
          .slice(0, 6)
      : [];

    return {
      score,
      status,
      grade: typeof parsed.grade === 'string' && parsed.grade.trim()
        ? parsed.grade.trim()
        : gradeFromStatus(status),
      summary: typeof parsed.summary === 'string' ? parsed.summary.trim().slice(0, 120) : '',
      issues,
      model,
      usage: response.data?.usage || null
    };
  } catch (error) {
    if (shouldSkipReviewForImageError(error)) {
      logger.warn('[OpenAI] Review skipped because image could not be fetched', {
        status: error?.response?.status || null,
        message: error?.response?.data?.error?.message || error.message
      });
      return null;
    }

    const message = error?.response?.data?.error?.message || error.message || 'OpenAI review request failed';
    const httpStatus = error?.response?.status || null;
    const isApiKeyError = /incorrect.*api.*key|invalid.*api.*key|authentication.*failed/i.test(message);
    const isRateLimit = httpStatus === 429;
    const isServerError = httpStatus >= 500;

    logger.error('[OpenAI] Review generation failed', {
      error: message,
      status: httpStatus,
      model,
      isApiKeyError,
      isRateLimit,
      isServerError
    });

    const reviewError = new Error(message);
    reviewError.code = isApiKeyError ? 'BACKEND_CONFIG_ERROR'
      : isRateLimit ? 'UPSTREAM_RATE_LIMITED'
      : isServerError ? 'UPSTREAM_GENERATION_ERROR'
      : 'REVIEW_ERROR';
    reviewError.httpStatus = httpStatus;
    throw reviewError;
  }
}

module.exports = {
  generateAltText,
  reviewAltText
};
