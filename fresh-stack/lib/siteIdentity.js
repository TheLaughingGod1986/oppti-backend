const crypto = require('crypto');

const DEV_HOST_PATTERNS = [
  /^localhost$/i,
  /^127(?:\.\d{1,3}){3}$/i,
  /^\[::1\]$/i,
  /^::1$/i,
  /^0\.0\.0\.0$/i,
  /^10(?:\.\d{1,3}){3}$/i,
  /^192\.168(?:\.\d{1,3}){2}$/i,
  /^172\.(1[6-9]|2\d|3[0-1])(?:\.\d{1,3}){2}$/i,
  /\.local$/i,
  /\.localhost$/i,
  /\.test$/i,
  /\.invalid$/i,
  /\.example$/i,
  /\.internal$/i
];

function normalizeIdentifier(value, maxLength = 255) {
  if (value === undefined || value === null) return null;
  const normalized = String(value).trim();
  if (!normalized) return null;
  return normalized.slice(0, maxLength);
}

function normalizeHost(hostname) {
  if (!hostname) return null;
  let host = String(hostname).trim().toLowerCase().replace(/\.+$/, '');
  if (!host) return null;
  if (host.startsWith('www.')) {
    host = host.slice(4);
  }
  return host || null;
}

function normalizeDomain(siteUrl) {
  if (!siteUrl || typeof siteUrl !== 'string') return null;

  const trimmed = siteUrl.trim();
  if (!trimmed) return null;

  let candidate = trimmed;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) {
    candidate = `https://${candidate}`;
  }

  try {
    const parsed = new URL(candidate);
    return normalizeHost(parsed.hostname);
  } catch (_error) {
    return null;
  }
}

function isDevelopmentHost(hostname) {
  const host = normalizeHost(hostname);
  if (!host) return false;
  return DEV_HOST_PATTERNS.some((pattern) => pattern.test(host));
}

function stripDefaultPort(protocol, port) {
  if (!port) return '';
  if ((protocol === 'http:' && port === '80') || (protocol === 'https:' && port === '443')) {
    return '';
  }
  return port;
}

function normalizeSiteUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') {
    return {
      normalizedSiteUrl: null,
      canonicalDomain: null,
      originalUrl: null,
      isDevelopment: false,
      isValid: false
    };
  }

  const trimmed = rawUrl.trim();
  const truncatedOriginal = trimmed.slice(0, 500);
  if (!trimmed) {
    return {
      normalizedSiteUrl: null,
      canonicalDomain: null,
      originalUrl: null,
      isDevelopment: false,
      isValid: false
    };
  }

  let candidate = trimmed;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) {
    candidate = `https://${candidate}`;
  }

  try {
    const parsed = new URL(candidate);
    const protocol = ['http:', 'https:'].includes(parsed.protocol) ? parsed.protocol : 'https:';
    const canonicalDomain = normalizeHost(parsed.hostname);
    if (!canonicalDomain) {
      return {
        normalizedSiteUrl: null,
        canonicalDomain: null,
        originalUrl: truncatedOriginal,
        isDevelopment: false,
        isValid: false
      };
    }

    const normalizedPort = stripDefaultPort(protocol, parsed.port);
    const pathname = parsed.pathname && parsed.pathname !== '/'
      ? parsed.pathname.replace(/\/+$/, '')
      : '';
    const normalizedSiteUrl = `${canonicalDomain}${normalizedPort ? `:${normalizedPort}` : ''}${pathname}`.slice(0, 500);

    return {
      normalizedSiteUrl,
      canonicalDomain: canonicalDomain.slice(0, 255),
      originalUrl: truncatedOriginal,
      isDevelopment: isDevelopmentHost(canonicalDomain),
      isValid: true
    };
  } catch (_error) {
    return {
      normalizedSiteUrl: null,
      canonicalDomain: null,
      originalUrl: truncatedOriginal,
      isDevelopment: false,
      isValid: false
    };
  }
}

function generateSyntheticSiteHash({
  wpInstallUuid,
  siteHash,
  siteFingerprint,
  normalizedSiteUrl,
  canonicalDomain
}) {
  const seed = [
    wpInstallUuid || '',
    siteHash || '',
    siteFingerprint || '',
    normalizedSiteUrl || '',
    canonicalDomain || ''
  ].filter(Boolean).join('|');

  if (!seed) return null;
  return crypto.createHash('sha256').update(seed).digest('hex');
}

function buildSiteIdentity({
  siteUrl,
  siteHash,
  siteFingerprint,
  installUuid,
  allowDevelopment = process.env.ALLOW_DEV_SITE_QUOTA === 'true' || process.env.NODE_ENV !== 'production'
} = {}) {
  const normalizedUrl = normalizeSiteUrl(siteUrl);
  const normalizedInstallUuid = normalizeIdentifier(installUuid || siteHash);
  const normalizedSiteHash = normalizeIdentifier(siteHash || installUuid);
  const normalizedFingerprint = normalizeIdentifier(siteFingerprint);
  const syntheticSiteHash = generateSyntheticSiteHash({
    wpInstallUuid: normalizedInstallUuid,
    siteHash: normalizedSiteHash,
    siteFingerprint: normalizedFingerprint,
    normalizedSiteUrl: normalizedUrl.normalizedSiteUrl,
    canonicalDomain: normalizedUrl.canonicalDomain
  });

  const isDevelopment = normalizedUrl.isDevelopment;
  const isAllowed = allowDevelopment || !isDevelopment;

  return {
    siteUrl: normalizedUrl.originalUrl,
    normalizedSiteUrl: normalizedUrl.normalizedSiteUrl,
    canonicalDomain: normalizedUrl.canonicalDomain,
    siteHash: normalizedSiteHash || syntheticSiteHash,
    siteFingerprint: normalizedFingerprint,
    wpInstallUuid: normalizedInstallUuid,
    isDevelopment,
    isAllowed,
    syntheticSiteHash,
    isValid: Boolean(
      normalizedInstallUuid
      || normalizedSiteHash
      || normalizedFingerprint
      || normalizedUrl.canonicalDomain
    ),
    error: !isAllowed
      ? 'DEVELOPMENT_SITE_NOT_ALLOWED'
      : !normalizedUrl.isValid && !normalizedInstallUuid && !normalizedSiteHash && !normalizedFingerprint
        ? 'INVALID_SITE_IDENTITY'
        : null
  };
}

function extractSiteIdentityFromRequest(req, body = req?.body || {}) {
  return buildSiteIdentity({
    siteUrl: req?.header('X-Site-URL') || body.site_url || body.siteUrl || null,
    siteHash: req?.header('X-Site-Hash') || req?.header('X-Site-Key') || body.site_id || body.siteId || body.siteHash || body.installId || null,
    siteFingerprint: req?.header('X-Site-Fingerprint') || body.site_fingerprint || body.siteFingerprint || body.fingerprint || null,
    installUuid: req?.header('X-Install-Hash') || req?.header('X-Install-UUID') || body.install_hash || body.installHash || body.install_uuid || body.installUuid || body.site_id || body.siteId || body.installId || null
  });
}

module.exports = {
  buildSiteIdentity,
  extractSiteIdentityFromRequest,
  normalizeIdentifier,
  normalizeHost,
  normalizeDomain,
  normalizeSiteUrl,
  isDevelopmentHost,
  generateSyntheticSiteHash
};
