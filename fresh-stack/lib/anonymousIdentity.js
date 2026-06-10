const crypto = require('crypto');

const SAFE_ANON_ID_PATTERN = /^[a-z0-9][a-z0-9._:-]{7,127}$/i;

function hashOpaqueValue(value) {
  if (value === undefined || value === null || value === '') return null;
  const salt = process.env.ANONYMOUS_ID_SALT || process.env.JWT_SECRET || 'bbai-anonymous';
  return crypto
    .createHash('sha256')
    .update(`${salt}:${String(value)}`)
    .digest('hex');
}

function normalizeAnonymousId(value) {
  if (value === undefined || value === null) return null;
  const trimmed = String(value).trim();
  if (!trimmed) return null;

  const truncated = trimmed.slice(0, 512);
  if (SAFE_ANON_ID_PATTERN.test(truncated)) {
    return truncated.toLowerCase();
  }

  return `anon_${hashOpaqueValue(truncated).slice(0, 40)}`;
}

function extractAnonymousIdFromRequest(req, body = req?.body || {}) {
  const candidates = [
    ['X-Anon-Id', req?.header?.('X-Anon-Id')],
    ['X-Anonymous-Id', req?.header?.('X-Anonymous-Id')],
    ['anon_id', body?.anon_id],
    ['anonId', body?.anonId]
  ];

  const match = candidates.find(([, value]) => value !== undefined && value !== null && String(value).trim() !== '');
  if (!match) {
    return {
      anonId: null,
      source: null,
      provided: false
    };
  }

  return {
    anonId: normalizeAnonymousId(match[1]),
    source: match[0],
    provided: true
  };
}

function getClientIp(req) {
  return req?.ip
    || req?.headers?.['x-forwarded-for']?.split(',')[0]?.trim()
    || req?.connection?.remoteAddress
    || 'unknown-ip';
}

function buildAnonymousContext({ req, body = req?.body || {}, siteIdentity = null } = {}) {
  const extracted = extractAnonymousIdFromRequest(req, body);
  const ip = getClientIp(req);
  const ipHash = hashOpaqueValue(ip);
  const siteIdentityKey = siteIdentity?.siteHash
    || siteIdentity?.siteFingerprint
    || siteIdentity?.wpInstallUuid
    || siteIdentity?.canonicalDomain
    || siteIdentity?.normalizedSiteUrl
    || null;

  const riskSeed = [
    extracted.anonId || null,
    siteIdentityKey,
    ipHash
  ].filter(Boolean).join('|');

  return {
    anonId: extracted.anonId,
    source: extracted.source,
    provided: extracted.provided,
    ipHash,
    siteIdentityKey,
    riskKey: riskSeed ? hashOpaqueValue(riskSeed).slice(0, 40) : null
  };
}

module.exports = {
  buildAnonymousContext,
  extractAnonymousIdFromRequest,
  getClientIp,
  hashOpaqueValue,
  normalizeAnonymousId
};
