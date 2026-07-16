/**
 * Stable, machine-readable error taxonomy for generation failures.
 *
 * Every failure is classified into exactly one `error_code` used by
 * structured logs and analytics events. The legacy `code` values
 * (GENERATION_FAILED, UPSTREAM_RATE_LIMITED, …) are preserved on API
 * responses for backward compatibility with existing plugin versions.
 */

const GENERATION_ERROR_CODES = Object.freeze({
  INVALID_REQUEST: 'invalid_request',
  AUTHENTICATION_FAILED: 'authentication_failed',
  QUOTA_EXHAUSTED: 'quota_exhausted',
  PROVIDER_AUTH_ERROR: 'provider_auth_error',
  PROVIDER_RATE_LIMITED: 'provider_rate_limited',
  PROVIDER_TIMEOUT: 'provider_timeout',
  PROVIDER_CONNECTION_ERROR: 'provider_connection_error',
  PROVIDER_INVALID_RESPONSE: 'provider_invalid_response',
  PROVIDER_CONTENT_REJECTED: 'provider_content_rejected',
  PROVIDER_SERVER_ERROR: 'provider_server_error',
  INTERNAL_ERROR: 'internal_error',
  INTERNAL_UNKNOWN_ERROR: 'internal_unknown_error'
});

const UNSUPPORTED_IMAGE_MESSAGE_PATTERN = /unsupported image|invalid.*image.*format|image.*(?:could not|cannot) be (?:decoded|processed)|unsupported file|invalid base64 image/i;
const CONTENT_REJECTED_MESSAGE_PATTERN = /content policy|content_policy|safety system|flagged|rejected as a result of|violat/i;
const API_KEY_MESSAGE_PATTERN = /incorrect.*api.*key|invalid.*api.*key|authentication.*failed/i;
const TIMEOUT_MESSAGE_PATTERN = /timeout|timed out/i;

/**
 * Classify a provider-call failure (axios error or structured throw).
 *
 * Returns:
 *  - errorCode:   stable taxonomy code for logs/analytics
 *  - legacyCode:  the `code` value existing plugins already understand
 *  - httpStatus:  status the API should return to the client
 *  - retryable:   whether the client may retry the same request
 * The original exception is never mutated beyond attaching these fields;
 * provider message details stay server-side.
 */
function classifyProviderError(error) {
  const message = error?.response?.data?.error?.message || error?.message || 'Provider request failed';
  const providerStatus = error?.response?.status || null;
  const hasResponse = Boolean(error?.response);
  const isTimeout = error?.code === 'ECONNABORTED' || (!hasResponse && TIMEOUT_MESSAGE_PATTERN.test(message));

  if (error?.code === 'BACKEND_CONFIG_ERROR') {
    return {
      errorCode: GENERATION_ERROR_CODES.PROVIDER_AUTH_ERROR,
      legacyCode: 'BACKEND_CONFIG_ERROR',
      httpStatus: 502,
      retryable: false,
      providerStatus
    };
  }

  if (isTimeout) {
    return {
      errorCode: GENERATION_ERROR_CODES.PROVIDER_TIMEOUT,
      legacyCode: 'UPSTREAM_GENERATION_ERROR',
      httpStatus: 504,
      retryable: true,
      providerStatus
    };
  }

  if (!hasResponse) {
    return {
      errorCode: GENERATION_ERROR_CODES.PROVIDER_CONNECTION_ERROR,
      legacyCode: 'UPSTREAM_GENERATION_ERROR',
      httpStatus: 502,
      retryable: true,
      providerStatus
    };
  }

  if (providerStatus === 401 || providerStatus === 403 || API_KEY_MESSAGE_PATTERN.test(message)) {
    return {
      errorCode: GENERATION_ERROR_CODES.PROVIDER_AUTH_ERROR,
      legacyCode: 'BACKEND_CONFIG_ERROR',
      httpStatus: 502,
      retryable: false,
      providerStatus
    };
  }

  if (providerStatus === 429) {
    return {
      errorCode: GENERATION_ERROR_CODES.PROVIDER_RATE_LIMITED,
      legacyCode: 'UPSTREAM_RATE_LIMITED',
      httpStatus: 503,
      retryable: true,
      providerStatus
    };
  }

  if (providerStatus >= 500) {
    return {
      errorCode: GENERATION_ERROR_CODES.PROVIDER_SERVER_ERROR,
      legacyCode: 'UPSTREAM_GENERATION_ERROR',
      httpStatus: 502,
      retryable: true,
      providerStatus
    };
  }

  // Provider rejected the request body. An unsupported/undecodable image is
  // the client's input problem: return a terminal 4xx so well-behaved
  // clients stop retrying (the July 2026 AVIF incident was 5 images retried
  // 3x each because this class previously surfaced as HTTP 500).
  if (UNSUPPORTED_IMAGE_MESSAGE_PATTERN.test(message)) {
    return {
      errorCode: GENERATION_ERROR_CODES.INVALID_REQUEST,
      legacyCode: 'INVALID_REQUEST',
      httpStatus: 400,
      retryable: false,
      providerStatus
    };
  }

  if (CONTENT_REJECTED_MESSAGE_PATTERN.test(message)) {
    return {
      errorCode: GENERATION_ERROR_CODES.PROVIDER_CONTENT_REJECTED,
      legacyCode: 'GENERATION_FAILED',
      httpStatus: 422,
      retryable: false,
      providerStatus
    };
  }

  return {
    errorCode: GENERATION_ERROR_CODES.INTERNAL_ERROR,
    legacyCode: 'GENERATION_FAILED',
    httpStatus: 502,
    retryable: false,
    providerStatus
  };
}

/**
 * Public, non-sensitive message for a normalized failure. Never echoes
 * provider payload details back to the client.
 */
function publicMessageFor(errorCode) {
  switch (errorCode) {
    case GENERATION_ERROR_CODES.INVALID_REQUEST:
      return 'The image format is not supported. Please use png, jpeg, gif or webp.';
    case GENERATION_ERROR_CODES.PROVIDER_AUTH_ERROR:
      return 'The alt text service is temporarily misconfigured. Please try again later.';
    case GENERATION_ERROR_CODES.PROVIDER_RATE_LIMITED:
      return 'The AI provider is rate limiting requests. Please retry shortly.';
    case GENERATION_ERROR_CODES.PROVIDER_TIMEOUT:
      return 'Alt text generation timed out. Please retry.';
    case GENERATION_ERROR_CODES.PROVIDER_CONNECTION_ERROR:
    case GENERATION_ERROR_CODES.PROVIDER_SERVER_ERROR:
      return 'Alt text generation temporarily unavailable. Please retry.';
    case GENERATION_ERROR_CODES.PROVIDER_CONTENT_REJECTED:
      return 'The AI provider declined to describe this image.';
    default:
      return 'Failed to generate alt text.';
  }
}

module.exports = {
  GENERATION_ERROR_CODES,
  classifyProviderError,
  publicMessageFor
};
