const { validateImagePayload, detectImageFormat } = require('../../lib/validation');

function b64(bytes, padTo = 2048) {
  const buffer = Buffer.concat([Buffer.from(bytes), Buffer.alloc(Math.max(0, padTo - bytes.length), 1)]);
  return buffer.toString('base64');
}

const PNG_B64 = b64([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_B64 = b64([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
const GIF_B64 = b64(Buffer.from('GIF89a'));
const WEBP_B64 = b64(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4, 0), Buffer.from('WEBP')]));
const AVIF_B64 = b64(Buffer.concat([Buffer.from([0x00, 0x00, 0x00, 0x1c]), Buffer.from('ftypavif')]));
const HEIC_B64 = b64(Buffer.concat([Buffer.from([0x00, 0x00, 0x00, 0x18]), Buffer.from('ftypheic')]));
const BMP_B64 = b64(Buffer.from('BM'));

describe('detectImageFormat', () => {
  test('detects the formats OpenAI supports', () => {
    expect(detectImageFormat(PNG_B64)).toBe('png');
    expect(detectImageFormat(JPEG_B64)).toBe('jpeg');
    expect(detectImageFormat(GIF_B64)).toBe('gif');
    expect(detectImageFormat(WEBP_B64)).toBe('webp');
  });

  test('detects unsupported formats from magic bytes', () => {
    expect(detectImageFormat(AVIF_B64)).toBe('avif');
    expect(detectImageFormat(HEIC_B64)).toBe('heic');
    expect(detectImageFormat(BMP_B64)).toBe('bmp');
  });

  test('returns null for unknown data', () => {
    expect(detectImageFormat('')).toBeNull();
    expect(detectImageFormat(Buffer.alloc(32, 7).toString('base64'))).toBeNull();
  });
});

describe('validateImagePayload image-format guard', () => {
  test('accepts supported base64 formats', () => {
    for (const base64 of [PNG_B64, JPEG_B64, GIF_B64, WEBP_B64]) {
      const { errors } = validateImagePayload({ base64, width: 10, height: 10 });
      expect(errors).toEqual([]);
    }
  });

  test('rejects AVIF base64 before it can reach the provider (July 2026 incident class)', () => {
    const { errors, normalized } = validateImagePayload({
      base64: AVIF_B64,
      filename: 'Laundry.avif',
      width: 10,
      height: 10
    });
    expect(errors.some((message) => /unsupported image format "avif"/i.test(message))).toBe(true);
    expect(normalized).not.toBeNull();
  });

  test('rejects HEIC base64', () => {
    const { errors } = validateImagePayload({ base64: HEIC_B64, width: 10, height: 10 });
    expect(errors.some((message) => /unsupported image format "heic"/i.test(message))).toBe(true);
  });

  test('rejects URL payloads with unsupported extensions or mime types', () => {
    const byExtension = validateImagePayload({ url: 'https://example.com/photo.avif', width: 10, height: 10 });
    expect(byExtension.errors.some((message) => /unsupported image format "avif"/i.test(message))).toBe(true);

    const byMime = validateImagePayload({
      url: 'https://example.com/photo',
      mime_type: 'image/heic',
      width: 10,
      height: 10
    });
    expect(byMime.errors.some((message) => /unsupported image format "heic"/i.test(message))).toBe(true);
  });

  test('does not reject unknown base64 headers (avoids false positives)', () => {
    const { errors } = validateImagePayload({
      base64: Buffer.alloc(2048, 7).toString('base64'),
      width: 10,
      height: 10
    });
    expect(errors).toEqual([]);
  });

  test('normalizes mime type from detected format', () => {
    const { normalized } = validateImagePayload({ base64: PNG_B64, mime_type: 'image/jpeg', width: 10, height: 10 });
    expect(normalized.mime_type).toBe('image/png');
  });
});
