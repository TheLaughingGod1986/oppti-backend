const logger = require('../../lib/logger');

describe('logger redaction', () => {
  test('redacts credentials, tokens, secrets, and email fields', () => {
    const info = jest.spyOn(console, 'info').mockImplementation(() => {});

    logger.info('[auth]', {
      email: 'person@example.com',
      password: 'password',
      authorization: 'Bearer token',
      session_token: 'session',
      safe: 'visible'
    });

    const serialized = JSON.stringify(info.mock.calls[0]);
    expect(serialized).not.toContain('person@example.com');
    expect(serialized).not.toContain('Bearer token');
    expect(serialized).not.toContain('"session"');
    expect(serialized).toContain('visible');
    expect(serialized).toContain('[REDACTED]');
    info.mockRestore();
  });
});
