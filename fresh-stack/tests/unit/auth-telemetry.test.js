jest.mock('../../lib/posthog', () => ({
  captureServerEvent: jest.fn(),
  EVENT_SCHEMA_VERSION: 2
}));

const logger = require('../../lib/logger');
const { captureServerEvent } = require('../../lib/posthog');
const {
  AUTH_ERRORS,
  buildAuthProperties,
  captureAuthEvent,
  normalizeCorrelationId
} = require('../../lib/authTelemetry');

function makeReq(headers = {}, body = {}) {
  return {
    id: 'backend-request-id',
    body,
    header: (name) => headers[name.toLowerCase()] || null
  };
}

describe('authentication telemetry', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test.each([
    ['invalid_credentials', 'authentication', 'credential_verification', false],
    ['account_disabled', 'account_state', 'account_check', false],
    ['email_not_verified', 'account_state', 'account_check', false],
    ['validation_failed', 'user_input', 'backend_validation', false],
    ['rate_limited', 'user_input', 'backend_validation', true],
    ['network_timeout', 'network', 'network_request', true],
    ['api_unavailable', 'upstream_service', 'credential_verification', true],
    ['malformed_response', 'upstream_service', 'response_parsing', true],
    ['token_creation_failed', 'session', 'token_creation', true],
    ['session_creation_failed', 'session', 'session_creation', true],
    ['server_error', 'server', 'unknown', true],
    ['unknown_auth_error', 'unknown', 'unknown', false]
  ])('maps %s to stable metadata', (code, category, stage, retryable) => {
    expect(AUTH_ERRORS[code]).toEqual(expect.objectContaining({ category, stage, retryable }));
  });

  test('accepts a safe client correlation ID and replaces malformed values', () => {
    expect(normalizeCorrelationId('login-attempt_1234')).toBe('login-attempt_1234');
    expect(normalizeCorrelationId('bad value')).toMatch(/^[0-9a-f-]{36}$/);
  });

  test('builds the documented event envelope without credentials', () => {
    const properties = buildAuthProperties(makeReq(
      { 'x-correlation-id': 'login-attempt_1234' },
      {
        email: 'person@example.com',
        password: 'do-not-capture',
        anon_id: 'anon-1',
        plugin_version: '2.3.4',
        install_uuid: 'install-1'
      }
    ), { error_code: 'invalid_credentials' });

    expect(properties).toEqual(expect.objectContaining({
      correlation_id: 'login-attempt_1234',
      plugin_version: '2.3.4',
      site_install_id: 'install-1',
      anonymous_distinct_id: 'anon-1',
      error_code: 'invalid_credentials',
      error_category: 'authentication',
      failure_stage: 'credential_verification',
      retryable: false,
      backend_request_id: 'backend-request-id',
      event_schema_version: 2
    }));
    expect(properties).not.toHaveProperty('email');
    expect(properties).not.toHaveProperty('password');
  });

  test('analytics failures do not reject or alter login behavior', async () => {
    captureServerEvent.mockRejectedValueOnce(new Error('PostHog unavailable'));
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => {});

    await expect(captureAuthEvent({
      req: makeReq({ 'x-correlation-id': 'login-attempt_1234' }),
      event: 'login_failed',
      properties: { error_code: 'server_error' }
    })).resolves.toEqual(expect.objectContaining({ ok: false }));

    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
