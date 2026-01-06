const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

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

  if (hasBase64) {
    if (!BASE64_PATTERN.test(rawBase64.trim())) {
      errors.push('Base64 data contains invalid characters. Ensure it is a clean base64 string without URL or metadata.');
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

  const normalized = {
    base64: hasBase64 ? rawBase64 : null,
    url: hasUrl ? image.url : null,
    width,
    height,
    filename: image.filename || null,
    mime_type: image.mime_type || (image.url && guessMimeFromUrl(image.url)) || 'image/jpeg'
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
  stripDataUrl
};
