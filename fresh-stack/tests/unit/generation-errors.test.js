const { classifyProviderError, GENERATION_ERROR_CODES } = require('../../lib/generationErrors');

function axiosError({ status = null, message = 'boom', code = null, data = null } = {}) {
  const error = new Error(message);
  if (code) error.code = code;
  if (status) {
    error.response = {
      status,
      data: data || { error: { message } }
    };
  }
  return error;
}

describe('classifyProviderError', () => {
  test('classifies the incident error (OpenAI 400 unsupported image) as terminal invalid_request', () => {
    const classified = classifyProviderError(axiosError({
      status: 400,
      message: "You uploaded an unsupported image. Please make sure your image has of one the following formats: ['png', 'jpeg', 'gif', 'webp']."
    }));
    expect(classified).toMatchObject({
      errorCode: GENERATION_ERROR_CODES.INVALID_REQUEST,
      legacyCode: 'INVALID_REQUEST',
      httpStatus: 400,
      retryable: false
    });
  });

  test('classifies provider authentication failures', () => {
    expect(classifyProviderError(axiosError({ status: 401, message: 'Incorrect API key provided' }))).toMatchObject({
      errorCode: GENERATION_ERROR_CODES.PROVIDER_AUTH_ERROR,
      legacyCode: 'BACKEND_CONFIG_ERROR',
      retryable: false
    });
    expect(classifyProviderError(axiosError({ status: 400, message: 'Invalid API key supplied' }))).toMatchObject({
      errorCode: GENERATION_ERROR_CODES.PROVIDER_AUTH_ERROR
    });
  });

  test('classifies provider rate limiting as retryable', () => {
    expect(classifyProviderError(axiosError({ status: 429, message: 'Rate limit reached' }))).toMatchObject({
      errorCode: GENERATION_ERROR_CODES.PROVIDER_RATE_LIMITED,
      legacyCode: 'UPSTREAM_RATE_LIMITED',
      httpStatus: 503,
      retryable: true
    });
  });

  test('classifies provider 5xx as retryable server errors', () => {
    expect(classifyProviderError(axiosError({ status: 503, message: 'The server is overloaded' }))).toMatchObject({
      errorCode: GENERATION_ERROR_CODES.PROVIDER_SERVER_ERROR,
      legacyCode: 'UPSTREAM_GENERATION_ERROR',
      httpStatus: 502,
      retryable: true
    });
  });

  test('classifies timeouts', () => {
    expect(classifyProviderError(axiosError({ message: 'timeout of 60000ms exceeded', code: 'ECONNABORTED' }))).toMatchObject({
      errorCode: GENERATION_ERROR_CODES.PROVIDER_TIMEOUT,
      httpStatus: 504,
      retryable: true
    });
  });

  test('classifies connection failures without a response', () => {
    expect(classifyProviderError(axiosError({ message: 'getaddrinfo ENOTFOUND api.openai.com', code: 'ENOTFOUND' }))).toMatchObject({
      errorCode: GENERATION_ERROR_CODES.PROVIDER_CONNECTION_ERROR,
      httpStatus: 502,
      retryable: true
    });
  });

  test('classifies content-policy rejections as terminal', () => {
    expect(classifyProviderError(axiosError({ status: 400, message: 'Your request was rejected as a result of our safety system.' }))).toMatchObject({
      errorCode: GENERATION_ERROR_CODES.PROVIDER_CONTENT_REJECTED,
      httpStatus: 422,
      retryable: false
    });
  });

  test('falls back to internal_error for unrecognized provider 4xx', () => {
    expect(classifyProviderError(axiosError({ status: 418, message: 'teapot' }))).toMatchObject({
      errorCode: GENERATION_ERROR_CODES.INTERNAL_ERROR,
      legacyCode: 'GENERATION_FAILED',
      retryable: false
    });
  });
});
