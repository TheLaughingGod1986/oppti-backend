jest.mock('axios', () => ({ post: jest.fn() }));

const axios = require('axios');
const { generateAltText } = require('../../lib/openai');

function providerRejection(status, message) {
  const error = new Error(message);
  error.response = { status, data: { error: { message } } };
  return error;
}

describe('generateAltText error normalization', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.OPENAI_API_KEY = 'sk-test-not-a-real-key';
  });

  test('provider 400 for unsupported image throws terminal invalid_request and does not auto-retry', async () => {
    axios.post.mockRejectedValue(providerRejection(
      400,
      "You uploaded an unsupported image. Please make sure your image has of one the following formats: ['png', 'jpeg', 'gif', 'webp']."
    ));

    await expect(generateAltText({
      image: { base64: 'aGVsbG8=', mime_type: 'image/avif', filename: 'x.avif' },
      context: {}
    })).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
      errorCode: 'invalid_request',
      httpStatusForClient: 400,
      isRetryable: false
    });

    // The provider client performs no automatic retries: one axios call per
    // generation attempt (the only second call ever made is the
    // model-missing fallback, which is not an error retry).
    expect(axios.post).toHaveBeenCalledTimes(1);
  });

  test('provider 429 throws retryable provider_rate_limited', async () => {
    axios.post.mockRejectedValue(providerRejection(429, 'Rate limit reached for requests'));

    await expect(generateAltText({ image: { base64: 'aGVsbG8=' }, context: {} })).rejects.toMatchObject({
      code: 'UPSTREAM_RATE_LIMITED',
      errorCode: 'provider_rate_limited',
      httpStatusForClient: 503,
      isRetryable: true
    });
    expect(axios.post).toHaveBeenCalledTimes(1);
  });

  test('provider timeout throws retryable provider_timeout', async () => {
    const timeoutError = new Error('timeout of 60000ms exceeded');
    timeoutError.code = 'ECONNABORTED';
    axios.post.mockRejectedValue(timeoutError);

    await expect(generateAltText({ image: { base64: 'aGVsbG8=' }, context: {} })).rejects.toMatchObject({
      errorCode: 'provider_timeout',
      httpStatusForClient: 504,
      isRetryable: true
    });
  });

  test('network failure throws retryable provider_connection_error', async () => {
    const connError = new Error('connect ECONNREFUSED');
    connError.code = 'ECONNREFUSED';
    axios.post.mockRejectedValue(connError);

    await expect(generateAltText({ image: { base64: 'aGVsbG8=' }, context: {} })).rejects.toMatchObject({
      errorCode: 'provider_connection_error',
      httpStatusForClient: 502,
      isRetryable: true
    });
  });

  test('provider auth failure throws non-retryable provider_auth_error', async () => {
    axios.post.mockRejectedValue(providerRejection(401, 'Incorrect API key provided'));

    await expect(generateAltText({ image: { base64: 'aGVsbG8=' }, context: {} })).rejects.toMatchObject({
      code: 'BACKEND_CONFIG_ERROR',
      errorCode: 'provider_auth_error',
      isRetryable: false
    });
  });

  test('missing API key throws provider_auth_error without calling the provider', async () => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.ALTTEXT_OPENAI_API_KEY;

    await expect(generateAltText({ image: { base64: 'aGVsbG8=' }, context: {} })).rejects.toMatchObject({
      code: 'BACKEND_CONFIG_ERROR',
      errorCode: 'provider_auth_error'
    });
    expect(axios.post).not.toHaveBeenCalled();
  });

  test('malformed provider response falls back to placeholder text (no throw)', async () => {
    axios.post.mockResolvedValue({ data: { choices: [] } });

    const result = await generateAltText({ image: { base64: 'aGVsbG8=' }, context: { title: 'Sample' } });
    expect(result.altText).toContain('Sample');
    expect(result.meta.usedFallback).toBe(true);
  });
});
