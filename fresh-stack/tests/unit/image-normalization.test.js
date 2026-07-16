const sharp = require('sharp');
const logger = require('../../lib/logger');
const {
  normalizeImageForProvider,
  ImageNormalizationError,
  DEFAULT_LIMITS
} = require('../../lib/imageNormalization');

async function makePng({ width = 40, height = 30, alpha = 1 } = {}) {
  return sharp({
    create: { width, height, channels: 4, background: { r: 180, g: 40, b: 40, alpha } }
  }).png().toBuffer();
}

async function makeAvif(options = {}) {
  const png = await makePng(options);
  return sharp(png).avif({ quality: 55 }).toBuffer();
}

describe('normalizeImageForProvider', () => {
  test('converts real AVIF to genuine WebP with correct metadata', async () => {
    const avif = await makeAvif({ width: 48, height: 32 });
    expect(avif.slice(4, 12).toString('latin1')).toBe('ftypavif');

    const result = await normalizeImageForProvider({
      buffer: avif,
      declaredMimeType: 'image/avif',
      source: 'test'
    });

    expect(result.converted).toBe(true);
    expect(result.originalFormat).toBe('avif');
    expect(result.format).toBe('webp');
    expect(result.mimeType).toBe('image/webp');
    expect(result.durationMs).toEqual(expect.any(Number));

    // The bytes must be real WebP, not relabeled AVIF.
    expect(result.buffer.slice(0, 4).toString('latin1')).toBe('RIFF');
    expect(result.buffer.slice(8, 12).toString('latin1')).toBe('WEBP');

    const decoded = await sharp(result.buffer).metadata();
    expect(decoded.format).toBe('webp');
    expect(decoded.width).toBe(48);
    expect(decoded.height).toBe(32);
    expect(result.width).toBe(48);
    expect(result.height).toBe(32);
  });

  test('preserves alpha transparency through conversion', async () => {
    const avif = await makeAvif({ alpha: 0.5 });
    const result = await normalizeImageForProvider({ buffer: avif });

    expect(result.hasAlpha).toBe(true);
    const decoded = await sharp(result.buffer).metadata();
    expect(decoded.hasAlpha).toBe(true);
  });

  test('applies EXIF orientation during conversion', async () => {
    const png = await makePng({ width: 40, height: 20 });
    const avif = await sharp(png).withMetadata({ orientation: 6 }).avif({ quality: 55 }).toBuffer();

    const result = await normalizeImageForProvider({ buffer: avif });

    // Orientation 6 = 90° rotation: output dimensions swap.
    const decoded = await sharp(result.buffer).metadata();
    expect(decoded.width).toBe(20);
    expect(decoded.height).toBe(40);
    expect(result.width).toBe(20);
    expect(result.height).toBe(40);
    // Orientation metadata is consumed, not carried along.
    expect(decoded.orientation).toBeUndefined();
  });

  test('passes provider-supported formats through untouched', async () => {
    const png = await makePng();
    const result = await normalizeImageForProvider({ buffer: png, declaredMimeType: 'image/png' });

    expect(result.converted).toBe(false);
    expect(result.buffer).toBe(png);
    expect(result.mimeType).toBe('image/png');
    expect(result.originalFormat).toBe('png');
  });

  test('logs a mismatch when declared mime disagrees with detected bytes (no filename, no content)', async () => {
    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      const avif = await makeAvif();
      await normalizeImageForProvider({
        buffer: avif,
        declaredMimeType: 'image/jpeg',
        filename: 'holiday-photo-of-me.jpg',
        source: 'test'
      });

      const mismatch = warnSpy.mock.calls.find(([msg]) => msg === '[image-normalize] declared_mime_mismatch');
      expect(mismatch).toBeDefined();
      expect(mismatch[1]).toMatchObject({ declared_format: 'jpeg', detected_format: 'avif' });
      expect(JSON.stringify(mismatch[1])).not.toContain('holiday-photo-of-me');
    } finally {
      warnSpy.mockRestore();
    }
  });

  test('rejects empty input as invalid_image', async () => {
    await expect(normalizeImageForProvider({ buffer: Buffer.alloc(0) })).rejects.toMatchObject({
      errorCode: 'invalid_image',
      httpStatus: 400,
      retryable: false
    });
  });

  test('rejects corrupt AVIF cleanly as image_decode_failed', async () => {
    const corrupt = Buffer.concat([
      Buffer.from([0x00, 0x00, 0x00, 0x1c]),
      Buffer.from('ftypavif'),
      Buffer.alloc(500, 0x37)
    ]);

    const rejection = normalizeImageForProvider({ buffer: corrupt });
    await expect(rejection).rejects.toBeInstanceOf(ImageNormalizationError);
    await expect(rejection).rejects.toMatchObject({
      errorCode: 'image_decode_failed',
      httpStatus: 400,
      retryable: false
    });
    // Client-safe message; raw decoder detail stays internal.
    await rejection.catch((error) => {
      expect(error.publicMessage).toMatch(/could not read this image/i);
      expect(error.publicMessage).not.toMatch(/heif|libvips|vips/i);
    });
  });

  test('rejects unknown binary data as unsupported_image_format', async () => {
    await expect(normalizeImageForProvider({ buffer: Buffer.alloc(256, 0x11) })).rejects.toMatchObject({
      errorCode: 'unsupported_image_format',
      retryable: false
    });
  });

  test('rejects oversized encoded input as image_too_large before decoding', async () => {
    const avif = await makeAvif();
    await expect(normalizeImageForProvider(
      { buffer: avif },
      { limits: { maxInputBytes: 10 } }
    )).rejects.toMatchObject({ errorCode: 'image_too_large', retryable: false });
  });

  test('rejects excessive dimensions as image_dimensions_exceeded before conversion', async () => {
    const avif = await makeAvif({ width: 64, height: 64 });
    await expect(normalizeImageForProvider(
      { buffer: avif },
      { limits: { maxDimension: 32 } }
    )).rejects.toMatchObject({ errorCode: 'image_dimensions_exceeded', retryable: false });

    await expect(normalizeImageForProvider(
      { buffer: avif },
      // Pixel budget below 64x64 — metadata check must catch it.
      { limits: { maxPixels: 1000 } }
    )).rejects.toMatchObject({
      errorCode: expect.stringMatching(/image_dimensions_exceeded|image_decode_failed/)
    });
  });

  test('rejects animated images as unsupported_animated_image without converting', async () => {
    const fakeSharp = jest.fn(() => ({
      metadata: async () => ({ width: 10, height: 10, pages: 4, hasAlpha: false }),
      rotate: () => { throw new Error('conversion must not run for animated input'); }
    }));
    const avif = await makeAvif();

    await expect(normalizeImageForProvider(
      { buffer: avif },
      { sharpImpl: fakeSharp }
    )).rejects.toMatchObject({
      errorCode: 'unsupported_animated_image',
      httpStatus: 422,
      retryable: false
    });
  });

  test('enforces the processing timeout as image_conversion_failed', async () => {
    const never = new Promise(() => {});
    const fakeSharp = jest.fn(() => ({
      metadata: async () => ({ width: 10, height: 10, pages: 1, hasAlpha: false }),
      rotate() { return this; },
      webp() { return this; },
      toBuffer: () => never
    }));
    const avif = await makeAvif();

    await expect(normalizeImageForProvider(
      { buffer: avif },
      { sharpImpl: fakeSharp, limits: { timeoutMs: 25 } }
    )).rejects.toMatchObject({ errorCode: 'image_conversion_failed', retryable: false });
  });

  test('default limits are production-sane', () => {
    expect(DEFAULT_LIMITS.maxInputBytes).toBe(4 * 1024 * 1024);
    expect(DEFAULT_LIMITS.maxPixels).toBeLessThanOrEqual(50_000_000);
    expect(DEFAULT_LIMITS.maxFrames).toBe(1);
    expect(DEFAULT_LIMITS.timeoutMs).toBeGreaterThan(0);
    expect(DEFAULT_LIMITS.maxConcurrent).toBeGreaterThan(0);
  });
});
