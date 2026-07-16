/**
 * Provider-safe image normalization.
 *
 * OpenAI's vision API accepts png/jpeg/gif/webp only. Formats we can decode
 * server-side (currently AVIF) are converted to WebP here — before any quota
 * reservation or provider call — instead of being rejected. Formats we
 * cannot safely decode (HEIC, BMP, TIFF, …) keep failing fast in
 * lib/validation.js.
 *
 * Every failure thrown from this module is an ImageNormalizationError: a
 * permanent, non-retryable input error with a stable machine-readable code
 * and a client-safe message. Raw decoder errors stay server-side.
 */

const sharp = require('sharp');
const logger = require('./logger');
const {
  detectImageFormat,
  SUPPORTED_IMAGE_FORMATS,
  CONVERTIBLE_IMAGE_FORMATS
} = require('./validation');

// Sized for the Render starter instance (512 MB RAM, shared CPU) and the
// existing 4 MB base64 payload guard in lib/validation.js:
// - 24 MP decoded (~96 MB RGBA) keeps peak decode memory well under the
//   instance ceiling even with concurrent conversions.
// - 8192 px per side matches common CDN/browser limits.
// - one frame only: animated sources are ambiguous input for alt text.
// - 10 s timeout: local AVIF decodes finish in well under a second; a decode
//   that runs longer is hostile or corrupt.
// - 4 concurrent conversions caps worst-case memory and leaves CPU for the
//   event loop.
const DEFAULT_LIMITS = Object.freeze({
  maxInputBytes: 4 * 1024 * 1024,
  maxPixels: 24_000_000,
  maxDimension: 8192,
  maxFrames: 1,
  timeoutMs: 10_000,
  maxConcurrent: 4,
  webpQuality: 85
});

class ImageNormalizationError extends Error {
  constructor(errorCode, { httpStatus = 422, publicMessage, internalMessage } = {}) {
    super(internalMessage || publicMessage || errorCode);
    this.name = 'ImageNormalizationError';
    this.errorCode = errorCode;
    this.httpStatus = httpStatus;
    this.httpStatusForClient = httpStatus;
    this.retryable = false;
    this.isRetryable = false;
    this.publicMessage = publicMessage || 'We could not process this image. Please convert it to JPEG, PNG, or WebP and try again.';
  }
}

let activeConversions = 0;
const conversionQueue = [];

async function withConversionSlot(maxConcurrent, fn) {
  if (activeConversions >= maxConcurrent) {
    await new Promise((resolve) => conversionQueue.push(resolve));
  }
  activeConversions += 1;
  try {
    return await fn();
  } finally {
    activeConversions -= 1;
    const next = conversionQueue.shift();
    if (next) next();
  }
}

function withTimeout(promise, timeoutMs, onTimeoutError) {
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(onTimeoutError()), timeoutMs);
    if (timer.unref) timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Normalize an image payload into a provider-supported representation.
 *
 * Input:  { buffer, declaredMimeType, filename, source, logContext }
 * Output: { buffer, mimeType, format, originalFormat, converted,
 *           width, height, hasAlpha, durationMs }
 *
 * Supported formats pass through untouched (no decode — cheap path).
 * AVIF is decoded, orientation-corrected, and re-encoded as WebP.
 * Throws ImageNormalizationError (permanent, non-retryable) on any failure.
 */
async function normalizeImageForProvider({
  buffer,
  declaredMimeType = null,
  filename = null,
  source = null,
  logContext = {}
} = {}, {
  limits: limitOverrides = {},
  sharpImpl = sharp
} = {}) {
  const limits = { ...DEFAULT_LIMITS, ...limitOverrides };
  const startedAt = Date.now();

  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new ImageNormalizationError('invalid_image', {
      httpStatus: 400,
      publicMessage: 'The uploaded image is empty or unreadable.',
      internalMessage: 'normalizeImageForProvider called without a non-empty buffer'
    });
  }

  if (buffer.length > limits.maxInputBytes) {
    throw new ImageNormalizationError('image_too_large', {
      publicMessage: `The image is too large to process (max ${Math.round(limits.maxInputBytes / (1024 * 1024))}MB). Please resize or compress it.`,
      internalMessage: `input ${buffer.length} bytes exceeds maxInputBytes ${limits.maxInputBytes}`
    });
  }

  const detectedFormat = detectImageFormat(buffer.toString('base64', 0, 64));
  const declaredFormat = typeof declaredMimeType === 'string'
    ? declaredMimeType.replace(/^image\//i, '').toLowerCase() || null
    : null;

  if (detectedFormat && declaredFormat && detectedFormat !== declaredFormat
    && !(detectedFormat === 'jpeg' && declaredFormat === 'jpg')) {
    // Content is the source of truth; the mismatch is logged (no image
    // bytes, no filenames) and the detected format wins.
    logger.warn('[image-normalize] declared_mime_mismatch', {
      ...logContext,
      source: source || null,
      declared_format: declaredFormat,
      detected_format: detectedFormat
    });
  }

  // Already provider-supported: pass through without decoding.
  if (detectedFormat && SUPPORTED_IMAGE_FORMATS.has(detectedFormat)) {
    return {
      buffer,
      mimeType: `image/${detectedFormat}`,
      format: detectedFormat,
      originalFormat: detectedFormat,
      converted: false,
      width: null,
      height: null,
      hasAlpha: null,
      durationMs: Date.now() - startedAt
    };
  }

  if (!detectedFormat || !CONVERTIBLE_IMAGE_FORMATS.has(detectedFormat)) {
    // Validation already rejects known-unsupported formats; this guards
    // callers that skip validation and unknown binary data.
    throw new ImageNormalizationError('unsupported_image_format', {
      publicMessage: 'This image format is not supported. Please upload a JPEG, PNG, GIF, or WebP image.',
      internalMessage: `detected format ${detectedFormat || 'unknown'} is not convertible`
    });
  }

  const originalFormat = detectedFormat;
  const decodeFailed = (error) => new ImageNormalizationError('image_decode_failed', {
    httpStatus: 400,
    publicMessage: 'We could not read this image. It may be corrupt — please re-export it as JPEG, PNG, or WebP.',
    internalMessage: `decode failed for ${originalFormat}: ${error.message}`
  });

  let metadata;
  try {
    metadata = await withTimeout(
      sharpImpl(buffer, { limitInputPixels: limits.maxPixels }).metadata(),
      limits.timeoutMs,
      () => new ImageNormalizationError('image_conversion_failed', {
        publicMessage: 'Processing this image took too long. Please convert it to JPEG, PNG, or WebP and try again.',
        internalMessage: `metadata read exceeded ${limits.timeoutMs}ms`
      })
    );
  } catch (error) {
    if (error instanceof ImageNormalizationError) throw error;
    throw decodeFailed(error);
  }

  const frames = metadata.pages || 1;
  if (frames > limits.maxFrames) {
    throw new ImageNormalizationError('unsupported_animated_image', {
      publicMessage: 'Animated images are not supported for alt text generation. Please upload a still image.',
      internalMessage: `animated ${originalFormat} with ${frames} frames rejected`
    });
  }

  const width = metadata.width || 0;
  const height = metadata.height || 0;
  if (!width || !height) {
    throw decodeFailed(new Error('image reports no dimensions'));
  }
  if (width > limits.maxDimension || height > limits.maxDimension || width * height > limits.maxPixels) {
    throw new ImageNormalizationError('image_dimensions_exceeded', {
      publicMessage: `The image dimensions are too large to process (max ${limits.maxDimension}px per side). Please resize it first.`,
      internalMessage: `dimensions ${width}x${height} exceed limits`
    });
  }

  let convertedBuffer;
  try {
    convertedBuffer = await withConversionSlot(limits.maxConcurrent, () => withTimeout(
      sharpImpl(buffer, { limitInputPixels: limits.maxPixels })
        .rotate() // apply EXIF orientation before it is stripped
        .webp({ quality: limits.webpQuality })
        .toBuffer(),
      limits.timeoutMs,
      () => new ImageNormalizationError('image_conversion_failed', {
        publicMessage: 'Processing this image took too long. Please convert it to JPEG, PNG, or WebP and try again.',
        internalMessage: `conversion exceeded ${limits.timeoutMs}ms`
      })
    ));
  } catch (error) {
    if (error instanceof ImageNormalizationError) throw error;
    throw new ImageNormalizationError('image_conversion_failed', {
      publicMessage: 'We could not process this AVIF image. Please try converting it to JPEG, PNG, or WebP.',
      internalMessage: `webp encode failed for ${originalFormat}: ${error.message}`
    });
  }

  // Report the dimensions of what the provider will actually receive
  // (orientation correction can swap width/height).
  let outputMeta = { width, height, hasAlpha: metadata.hasAlpha === true };
  try {
    const decoded = await sharpImpl(convertedBuffer).metadata();
    outputMeta = {
      width: decoded.width || width,
      height: decoded.height || height,
      hasAlpha: decoded.hasAlpha === true
    };
  } catch (_error) {
    // Best effort — fall back to input metadata.
  }

  const durationMs = Date.now() - startedAt;
  logger.info('[image-normalize] converted', {
    ...logContext,
    source: source || null,
    original_format: originalFormat,
    provider_format: 'webp',
    image_width: outputMeta.width,
    image_height: outputMeta.height,
    has_alpha: outputMeta.hasAlpha,
    input_bytes: buffer.length,
    output_bytes: convertedBuffer.length,
    conversion_duration_ms: durationMs
  });

  return {
    buffer: convertedBuffer,
    mimeType: 'image/webp',
    format: 'webp',
    originalFormat,
    converted: true,
    width: outputMeta.width,
    height: outputMeta.height,
    hasAlpha: outputMeta.hasAlpha,
    durationMs
  };
}

module.exports = {
  normalizeImageForProvider,
  ImageNormalizationError,
  CONVERTIBLE_IMAGE_FORMATS,
  DEFAULT_LIMITS
};
