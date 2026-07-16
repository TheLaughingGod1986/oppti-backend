const crypto = require('crypto');
const logger = require('../lib/logger');

const EMAIL_STATUS_BY_EVENT = Object.freeze({
  'contact.unsubscribed': 'unsubscribed',
  'email.unsubscribed': 'unsubscribed',
  'email.resubscribed': 'subscribed',
  'email.softBounced': 'soft_bounced',
  'email.hardBounced': 'hard_bounced',
  'email.spamReported': 'spam_reported'
});

function verifyLoopsSignature({ rawBody, eventId, timestamp, signatureHeader, signingSecret }) {
  if (!eventId || !timestamp || !signatureHeader || !signingSecret) return false;
  const secretPart = signingSecret.includes('_') ? signingSecret.split('_').slice(1).join('_') : signingSecret;
  let secretBytes;
  try {
    secretBytes = Buffer.from(secretPart, 'base64');
  } catch (_error) {
    return false;
  }
  if (!secretBytes.length) return false;

  const expected = crypto
    .createHmac('sha256', secretBytes)
    .update(`${eventId}.${timestamp}.${rawBody.toString('utf8')}`)
    .digest('base64');

  return signatureHeader.split(' ').some((candidate) => {
    const supplied = candidate.includes(',') ? candidate.slice(candidate.indexOf(',') + 1) : candidate;
    const suppliedBuffer = Buffer.from(supplied);
    const expectedBuffer = Buffer.from(expected);
    return suppliedBuffer.length === expectedBuffer.length
      && crypto.timingSafeEqual(suppliedBuffer, expectedBuffer);
  });
}

async function updateAccountEmailStatus(supabase, payload) {
  const status = EMAIL_STATUS_BY_EVENT[payload.eventName];
  const identity = payload.contactIdentity || payload.contact || {};
  if (!status || (!identity.userId && !identity.email)) return;

  const update = {
    loops_contact_id: identity.id || null,
    marketing_email_status: status,
    loops_last_event_at: payload.eventTime
      ? new Date(payload.eventTime * 1000).toISOString()
      : new Date().toISOString()
  };
  let query = supabase.from('licenses').update(update);
  query = identity.userId ? query.eq('id', identity.userId) : query.eq('email', identity.email);
  const { error } = await query;
  if (error) throw error;
}

function createLoopsWebhookHandler({ supabase, signingSecret = process.env.LOOPS_SIGNING_SECRET }) {
  return async (req, res) => {
    const eventId = req.header('webhook-id');
    const timestamp = req.header('webhook-timestamp');
    const signature = req.header('webhook-signature');
    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');

    if (!signingSecret) {
      logger.error('[loops-webhook] Signing secret not configured');
      return res.status(503).json({ success: false, code: 'WEBHOOK_NOT_CONFIGURED' });
    }
    if (!verifyLoopsSignature({ rawBody, eventId, timestamp, signatureHeader: signature, signingSecret })) {
      logger.warn('[loops-webhook] Signature verification failed', { event_id: eventId || null });
      return res.status(401).json({ success: false, code: 'INVALID_SIGNATURE' });
    }

    let payload;
    try {
      payload = JSON.parse(rawBody.toString('utf8'));
    } catch (_error) {
      return res.status(400).json({ success: false, code: 'INVALID_JSON' });
    }

    try {
      const { error } = await supabase.from('loops_webhook_events').insert({
        webhook_id: eventId,
        event_name: payload.eventName,
        event_time: payload.eventTime ? new Date(payload.eventTime * 1000).toISOString() : null,
        contact_id: payload.contactIdentity?.id || payload.contact?.id || null,
        contact_user_id: payload.contactIdentity?.userId || payload.contact?.userId || null,
        contact_email: payload.contactIdentity?.email || payload.contact?.email || null,
        payload
      });
      if (error && error.code !== '23505') throw error;
      if (!error) await updateAccountEmailStatus(supabase, payload);
      return res.status(200).json({ success: true, duplicate: error?.code === '23505' });
    } catch (error) {
      logger.error('[loops-webhook] Processing failed', {
        event_id: eventId,
        event_name: payload.eventName || null,
        error: error.message
      });
      return res.status(500).json({ success: false, code: 'WEBHOOK_PROCESSING_FAILED' });
    }
  };
}

module.exports = { createLoopsWebhookHandler, verifyLoopsSignature };
