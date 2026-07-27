const crypto = require('crypto');
const { verifyLoopsSignature } = require('../../routes/loopsWebhook');

describe('Loops webhook verification', () => {
  test('accepts the documented HMAC signature format', () => {
    const secretBytes = Buffer.from('loops-test-secret');
    const signingSecret = `whsec_${secretBytes.toString('base64')}`;
    const rawBody = Buffer.from(JSON.stringify({ eventName: 'testing.testEvent' }));
    const eventId = 'msg_123';
    const timestamp = '1782122314';
    const signature = crypto
      .createHmac('sha256', secretBytes)
      .update(`${eventId}.${timestamp}.${rawBody.toString('utf8')}`)
      .digest('base64');

    expect(verifyLoopsSignature({
      rawBody,
      eventId,
      timestamp,
      signatureHeader: `v1,${signature}`,
      signingSecret
    })).toBe(true);
  });

  test('rejects a mismatched signature', () => {
    expect(verifyLoopsSignature({
      rawBody: Buffer.from('{}'),
      eventId: 'msg_123',
      timestamp: '1782122314',
      signatureHeader: 'v1,bad',
      signingSecret: `whsec_${Buffer.from('secret').toString('base64')}`
    })).toBe(false);
  });
});
