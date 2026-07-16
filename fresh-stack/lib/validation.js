const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

// Formats the OpenAI vision API accepts. Anything else (heic, bmp, tiff,
// svg, ico…) is rejected by the provider with a 400, so we must fail fast
// here instead of reserving quota and calling the provider.
const SUPPORTED_IMAGE_FORMATS = new Set(['png', 'jpeg', 'gif', 'webp']);

// Formats the provider rejects but lib/imageNormalization.js can safely
// convert server-side (base64 payloads only — URL payloads are fetched by
// the provider directly, so they must already be provider-supported).
const CONVERTIBLE_IMAGE_FORMATS = new Set(['avif']);

const UNSUPPORTED_EXTENSION_PATTERN = /\.(avif|heic|heif|bmp|tiff?|svg|ico)(\?.*)?$/i;

const MIME_TO_FORMAT = {
  'image/png': 'png',
  'image/jpeg': 'jpeg',
  'image/jpg': 'jpeg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'image/bmp': 'bmp',
  'image/tiff': 'tiff',
  'image/svg+xml': 'svg',
  'image/x-icon': 'ico',
  'image/vnd.microsoft.icon': 'ico'
};

/**
 * Identify the real image format from base64 magic bytes.
 * Returns a format string ('png', 'jpeg', 'avif', …) or null when unknown.
 */
function detectImageFormat(base64 = '') {
  if (!base64 || typeof base64 !== 'string') return null;

  let header;
  try {
    header = Buffer.from(base64.slice(0, 48), 'base64');
  } catch (_error) {
    return null;
  }
  if (!header || header.length < 4) return null;

  if (header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) return 'jpeg';
  if (header[0] === 0x89 && header[1] === 0x50 && header[2] === 0x4e && header[3] === 0x47) return 'png';
  if (header.slice(0, 4).toString('latin1') === 'GIF8') return 'gif';
  if (header.length >= 12
    && header.slice(0, 4).toString('latin1') === 'RIFF'
    && header.slice(8, 12).toString('latin1') === 'WEBP') return 'webp';

  // ISO-BMFF container: bytes 4-8 are 'ftyp' and the brand names the codec.
  if (header.length >= 12 && header.slice(4, 8).toString('latin1') === 'ftyp') {
    const brand = header.slice(8, 12).toString('latin1').toLowerCase();
    if (brand.startsWith('avi')) return 'avif';
    if (brand.startsWith('hei') || brand.startsWith('hev') || brand === 'mif1' || brand === 'msf1') return 'heic';
    return 'iso-bmff';
  }

  if (header[0] === 0x42 && header[1] === 0x4d) return 'bmp';
  if ((header[0] === 0x49 && header[1] === 0x49 && header[2] === 0x2a && header[3] === 0x00)
    || (header[0] === 0x4d && header[1] === 0x4d && header[2] === 0x00 && header[3] === 0x2a)) return 'tiff';
  if (header[0] === 0x00 && header[1] === 0x00 && header[2] === 0x01 && header[3] === 0x00) return 'ico';

  const asText = header.toString('latin1').trimStart().toLowerCase();
  if (asText.startsWith('<?xml') || asText.startsWith('<svg')) return 'svg';

  return null;
}

function unsupportedFormatError(format) {
  return `Unsupported image format "${format}". Supported formats: png, jpeg, gif, webp. Convert the image (e.g. from AVIF/HEIC) before requesting alt text.`;
}

function stripDataUrl(value = '') {
  if (value.startsWith('data:')) {
    const [, base64Part] = value.split('base64,');
    return base64Part || '';
  }
  return value;
}

function validateImagePayload(image = {}) {
  const errors = [];
  const warnings = [];

  const rawBase64 = stripDataUrl(image.base64 || image.image_base64 || '');
  const hasBase64 = Boolean(rawBase64);
  const hasUrl = Boolean(image.url);

  if (!hasBase64 && !hasUrl) {
    errors.push('Provide either base64/image_base64 or a public https image URL.');
    return { errors, warnings, normalized: null };
  }

  let detectedFormat = null;
  if (hasBase64) {
    if (!BASE64_PATTERN.test(rawBase64.trim())) {
      errors.push('Base64 data contains invalid characters. Ensure it is a clean base64 string without URL or metadata.');
    } else {
      detectedFormat = detectImageFormat(rawBase64);
      if (detectedFormat
        && !SUPPORTED_IMAGE_FORMATS.has(detectedFormat)
        && !CONVERTIBLE_IMAGE_FORMATS.has(detectedFormat)) {
        errors.push(unsupportedFormatError(detectedFormat));
      }
    }
  } else if (hasUrl) {
    const declaredFormat = MIME_TO_FORMAT[String(image.mime_type || '').toLowerCase()] || null;
    const urlMatch = String(image.url).match(UNSUPPORTED_EXTENSION_PATTERN);
    if (declaredFormat && !SUPPORTED_IMAGE_FORMATS.has(declaredFormat)) {
      errors.push(unsupportedFormatError(declaredFormat));
    } else if (urlMatch) {
      errors.push(unsupportedFormatError(urlMatch[1].toLowerCase()));
    }
  }

  // Dimensions help keep token usage predictable; we warn if missing.
  const width = Number(image.width) || Number(image.reportedWidth) || null;
  const height = Number(image.height) || Number(image.reportedHeight) || null;
  if (!width || !height) {
    warnings.push('Width and height are missing; include them to keep token costs predictable.');
  }

  // Check if image exceeds 512px (optimal for cost savings)
  const maxDimension = Math.max(width || 0, height || 0);
  if (maxDimension > 512) {
    warnings.push(`Image is ${width}x${height} (max ${maxDimension}px). Resize to 512px max for 50% token savings with no quality loss for alt text.`);
  }

  // Analyze size expectations when base64 is present.
  if (hasBase64) {
    const base64Length = rawBase64.length;
    const decodedBytes = Math.round(base64Length * 0.75);
    const base64SizeKB = Math.round(decodedBytes / 1024);
    const pixelCount = width && height ? width * height : null;

    const bytesPerPixel = pixelCount ? decodedBytes / pixelCount : null;

    // Gray zone detection: prevent high token costs from corrupted/small base64
    // Only apply strict validation to larger images (>50K pixels) to avoid rejecting simple/solid color images
    if (pixelCount && pixelCount > 50000) { // Images > 50K pixels
      const expectedMinRawKB = (pixelCount * 0.00625) / 1024;
      const expectedMinSizeKB = Math.max(Math.round(expectedMinRawKB * 1.33), 2);
      const grayZoneThreshold = expectedMinSizeKB * 5;

      if (base64SizeKB >= expectedMinSizeKB && base64SizeKB < grayZoneThreshold) {
        // This is a warning, not an error - simple images can be legitimately small
        warnings.push(`Base64 size (${base64SizeKB}KB) is smaller than expected for ${width}x${height}. This may cause OpenAI to process at full resolution. Consider resizing to 512px for cost savings.`);
      } else if (base64SizeKB < expectedMinSizeKB && base64SizeKB < 1) {
        // Only error if it's extremely small (<1KB) which likely indicates corruption
        // Simple images (solid colors, icons) can be very small legitimately
        errors.push(`Base64 size (${base64SizeKB}KB) is extremely small for ${width}x${height}. Expected minimum ${expectedMinSizeKB}KB. Image may be truncated or corrupted.`);
      }
    } else if (pixelCount && pixelCount <= 50000) {
      // For smaller images, be more lenient - simple/solid color images can be very small
      if (base64SizeKB < 0.5) {
        // Only error if absolutely tiny (<0.5KB) which suggests corruption
        errors.push(`Base64 size (${base64SizeKB}KB) is extremely small for ${width}x${height}. Image may be corrupted or truncated.`);
      }
    }

    // Expected range based on light compression; only warn, do not block.
    // Simple images (solid colors, icons) can have very low bytes/pixel - this is normal
    if (bytesPerPixel !== null) {
      // Only warn if bytes/pixel is suspiciously low AND we have a large pixel count (suggests corruption)
      if (bytesPerPixel < 0.01 && pixelCount && pixelCount > 100000) {
        warnings.push(`Payload seems tiny for ${width}x${height} (${bytesPerPixel.toFixed(4)} bytes/px). Verify the image is fully encoded.`);
      } else if (bytesPerPixel > 0.35) {
        warnings.push(`Payload seems large for ${width}x${height} (${bytesPerPixel.toFixed(3)} bytes/px). Resize or compress before sending.`);
      }
    } else if (base64SizeKB < 5 && !pixelCount && base64SizeKB < 0.5) {
      // Only warn if extremely small without dimensions - simple images can legitimately be small
      warnings.push('Base64 payload is very small; ensure the image is not truncated.');
    }

    // Guardrails against enormous blobs: warn above 1MB, hard-fail above 4MB.
    const WARN_BASE64_KB = 1024;
    const MAX_BASE64_KB = 4096;
    if (base64SizeKB > MAX_BASE64_KB) {
      errors.push(`Base64 payload is too large (${base64SizeKB}KB). Resize before sending (target under ${MAX_BASE64_KB}KB).`);
    } else if (base64SizeKB > WARN_BASE64_KB) {
      warnings.push(`Base64 payload is large (${base64SizeKB}KB). Consider resizing/compressing to stay under ${WARN_BASE64_KB}KB to control token costs.`);
    }
  }

  // If URL is present but not https, warn.
  if (hasUrl && !String(image.url).startsWith('https://')) {
    warnings.push('Image URL should be https to be fetchable by the model.');
  }

  const detectedMime = detectedFormat ? `image/${detectedFormat}` : null;

  const normalized = {
    base64: hasBase64 ? rawBase64 : null,
    url: hasUrl ? image.url : null,
    width,
    height,
    filename: image.filename || null,
    mime_type: detectedMime || image.mime_type || (image.url && guessMimeFromUrl(image.url)) || 'image/jpeg'
  };

  return { errors, warnings, normalized };
}

function guessMimeFromUrl(url = '') {
  const lower = url.toLowerCase();
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.gif')) return 'image/gif';
  return 'image/jpeg';
}

module.exports = {
  validateImagePayload,
  stripDataUrl,
  detectImageFormat,
  SUPPORTED_IMAGE_FORMATS,
  CONVERTIBLE_IMAGE_FORMATS
};
