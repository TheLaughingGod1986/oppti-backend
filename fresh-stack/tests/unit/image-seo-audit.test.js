jest.mock('../../../fresh-stack/lib/email', () => ({
  sendImageSeoAuditEmail: jest.fn().mockResolvedValue({ success: true, messageId: 'email_123' })
}));

jest.mock('../../../src/services/loops', () => ({
  trackImageSeoAuditRequested: jest.fn().mockResolvedValue(undefined),
  trackImageSeoAuditCompleted: jest.fn().mockResolvedValue(undefined),
  trackImageSeoAuditFailed: jest.fn().mockResolvedValue(undefined)
}));

const dns = require('dns').promises;

function mockFetchResponse(url, text, contentType = 'text/html; charset=utf-8') {
  return {
    ok: true,
    status: 200,
    url,
    headers: {
      get: (name) => (String(name).toLowerCase() === 'content-type' ? contentType : null)
    },
    text: jest.fn().mockResolvedValue(text)
  };
}

describe('image SEO audit service', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(dns, 'lookup').mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  test('scores missing, generic, filename-like, and strong alt text', () => {
    const { scoreAltText } = require('../../services/imageSeoAudit');

    expect(scoreAltText(null).score).toBe(0);
    expect(scoreAltText('image').score).toBeLessThan(50);
    expect(scoreAltText('hero-banner.jpg', { filename: 'hero-banner.jpg' }).issues).toContain('Looks like a filename');
    expect(scoreAltText('Woman comparing image SEO reports on a WordPress dashboard').score).toBeGreaterThanOrEqual(85);
  });

  test('rejects private and local URLs', async () => {
    const { normalizeAuditUrl, assertPublicUrl } = require('../../services/imageSeoAudit');

    await expect(assertPublicUrl(normalizeAuditUrl('http://localhost:3000'))).rejects.toMatchObject({
      code: 'SITE_URL_PRIVATE'
    });

    dns.lookup.mockResolvedValueOnce([{ address: '192.168.1.10', family: 4 }]);
    await expect(assertPublicUrl(normalizeAuditUrl('https://example.com'))).rejects.toMatchObject({
      code: 'SITE_URL_PRIVATE'
    });
  });

  test('crawls public pages within caps and summarizes image issues', async () => {
    const { crawlPublicSite } = require('../../services/imageSeoAudit');

    global.fetch = jest.fn(async (url) => {
      if (String(url).endsWith('/sitemap.xml')) {
        return mockFetchResponse(String(url), '<urlset><url><loc>https://example.com/about</loc></url></urlset>', 'application/xml');
      }
      if (String(url).endsWith('/about')) {
        return mockFetchResponse(String(url), '<html><head><title>About</title></head><body><img src="/team.jpg" alt="team"></body></html>');
      }
      return mockFetchResponse(String(url), '<html><head><title>Home</title></head><body><a href="/about">About</a><img src="/hero.jpg"><img src="/audit.jpg" alt="Image SEO report in a WordPress dashboard"></body></html>');
    });

    const audit = await crawlPublicSite('https://example.com', { maxPages: 2, maxImages: 10 });

    expect(audit.summary.pagesScanned).toBe(2);
    expect(audit.summary.imagesScanned).toBe(3);
    expect(audit.summary.missingAltCount).toBe(1);
    expect(audit.summary.sampleImages.length).toBeGreaterThan(0);
  });

  test('follows apex to www redirects and still scores images', async () => {
    const { crawlPublicSite } = require('../../services/imageSeoAudit');

    global.fetch = jest.fn(async (url) => {
      const requested = String(url);
      if (requested === 'https://example.com/sitemap.xml') {
        return mockFetchResponse(
          'https://www.example.com/sitemap.xml',
          '<urlset><url><loc>https://www.example.com/about</loc></url></urlset>',
          'application/xml'
        );
      }
      if (requested === 'https://example.com/' || requested === 'https://example.com') {
        return mockFetchResponse(
          'https://www.example.com/',
          '<html><head><title>Home</title></head><body><a href="/about">About</a><img src="/hero.jpg" alt=""><img src="/good.jpg" alt="Woman reviewing an image SEO report"></body></html>'
        );
      }
      if (requested.includes('/about')) {
        return mockFetchResponse(
          'https://www.example.com/about',
          '<html><head><title>About</title></head><body><img src="/team.jpg" alt="team"></body></html>'
        );
      }
      return mockFetchResponse(
        requested.replace('https://example.com', 'https://www.example.com'),
        '<html><body><img src="/fallback.jpg"></body></html>'
      );
    });

    const audit = await crawlPublicSite('https://example.com', { maxPages: 2, maxImages: 10 });

    expect(audit.summary.pagesScanned).toBe(2);
    expect(audit.summary.imagesScanned).toBeGreaterThan(0);
    expect(audit.summary.crawlStatus).toBe('ok');
    expect(audit.summary.score).toBeGreaterThan(0);
    expect(audit.pages.every((page) => page.url.startsWith('https://www.example.com'))).toBe(true);
  });

  test('marks empty crawls as incomplete instead of clean', async () => {
    const { crawlPublicSite } = require('../../services/imageSeoAudit');

    global.fetch = jest.fn(async (url) => {
      if (String(url).endsWith('/sitemap.xml')) {
        const error = new Error('Fetch failed with 404');
        error.code = 'FETCH_FAILED';
        throw error;
      }
      const error = new Error('Fetch failed with 403');
      error.code = 'FETCH_FAILED';
      throw error;
    });

    const audit = await crawlPublicSite('https://example.com', { maxPages: 2, maxImages: 10 });

    expect(audit.summary.pagesScanned).toBe(0);
    expect(audit.summary.imagesScanned).toBe(0);
    expect(audit.summary.score).toBe(0);
    expect(audit.summary.crawlStatus).toBe('no_pages');
    expect(audit.summary.scoreBand).toBe('Crawl incomplete');
    expect(audit.summary.recommendations[0].title).toMatch(/could not crawl/i);
  });

  test('generates a non-empty PDF report', async () => {
    const { generateAuditPdfBuffer } = require('../../services/imageSeoAudit');

    const pdf = await generateAuditPdfBuffer({
      normalizedDomain: 'example.com',
      score: 72,
      pagesScanned: 2,
      imagesScanned: 3,
      missingAltCount: 1,
      missingAltPercent: 33,
      weakAltCount: 2,
      averageQuality: 68,
      topIssues: [{ issue: 'Missing alt text', count: 1 }],
      sampleImages: [],
      crawlLimits: { maxPages: 25, maxImages: 250 }
    });

    expect(Buffer.isBuffer(pdf)).toBe(true);
    expect(pdf.length).toBeGreaterThan(1000);
  });

  test('runs audit, sends report email, and emits Loops events', async () => {
    const { runImageSeoAudit } = require('../../services/imageSeoAudit');
    const { sendImageSeoAuditEmail } = require('../../lib/email');
    const loops = require('../../../src/services/loops');

    global.fetch = jest.fn(async (url) => {
      if (String(url).endsWith('/sitemap.xml')) {
        return mockFetchResponse(String(url), '<urlset></urlset>', 'application/xml');
      }
      return mockFetchResponse(String(url), '<html><body><img src="/hero.jpg" alt="Product image SEO dashboard"></body></html>');
    });

    const result = await runImageSeoAudit({
      supabase: null,
      auditId: '00000000-0000-4000-8000-000000000001',
      email: 'USER@EXAMPLE.COM',
      siteUrl: 'https://example.com'
    });

    expect(result.ok).toBe(true);
    expect(sendImageSeoAuditEmail).toHaveBeenCalledWith(expect.objectContaining({
      to: 'user@example.com',
      normalizedDomain: 'example.com',
      pdfBuffer: expect.any(Buffer)
    }));
    expect(loops.trackImageSeoAuditRequested).toHaveBeenCalledWith(expect.objectContaining({
      email: 'user@example.com',
      auditId: '00000000-0000-4000-8000-000000000001'
    }));
    expect(loops.trackImageSeoAuditCompleted).toHaveBeenCalledWith(expect.objectContaining({
      email: 'user@example.com',
      normalizedDomain: 'example.com',
      auditScore: expect.any(Number)
    }));
  });
});
