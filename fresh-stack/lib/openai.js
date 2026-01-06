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
    return {
      altText: fallbackAltText(context),
      usage: null,
      meta: { usedFallback: true, reason: 'Missing OpenAI API key' }
    };
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
    
    // Check for API key errors specifically
    const isApiKeyError = /incorrect.*api.*key|invalid.*api.*key|authentication.*failed/i.test(message);
    
    logger.error('[OpenAI] Alt text generation failed', {
      error: message,
      code: errorCode,
      status: error?.response?.status,
      model: modelUsed,
      hasApiKey: !!apiKey,
      apiKeyPrefix: apiKey ? apiKey.substring(0, 10) + '...' : 'missing',
      isApiKeyError: isApiKeyError
    });
    
    // If it's an API key error, log it prominently
    if (isApiKeyError) {
      logger.error('[OpenAI] CRITICAL: Invalid or missing OpenAI API key. Please check your .env.local file and ensure OPENAI_API_KEY is set correctly.');
    }
    
    return {
      altText: fallbackAltText(context),
      usage: null,
      meta: { usedFallback: true, reason: message, errorCode, isApiKeyError }
    };
  }
}

function fallbackAltText(context = {}) {
  const base = context.title || context.caption || context.pageTitle || 'Image';
  return `${base}: concise descriptive alt text placeholder`;
}

module.exports = {
  generateAltText
};
