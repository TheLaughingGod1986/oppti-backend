const crypto = require('crypto');
const dns = require('dns').promises;
const net = require('net');
const cheerio = require('cheerio');
const PDFDocument = require('pdfkit');
const logger = require('../lib/logger');
const { sendImageSeoAuditEmail } = require('../lib/email');
const {
  trackImageSeoAuditRequested,
  trackImageSeoAuditCompleted,
  trackImageSeoAuditFailed
} = require('../../src/services/loops');

const DEFAULT_MAX_PAGES = Number(process.env.IMAGE_SEO_AUDIT_MAX_PAGES || 25);
const DEFAULT_MAX_IMAGES = Number(process.env.IMAGE_SEO_AUDIT_MAX_IMAGES || 250);
const FETCH_TIMEOUT_MS = Number(process.env.IMAGE_SEO_AUDIT_FETCH_TIMEOUT_MS || 8000);
const USER_AGENT = 'OpttiAI-Image-SEO-Audit/1.0 (+https://oppti.dev/image-seo-audit)';

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function normalizeAuditUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) throw buildValidationError('SITE_URL_REQUIRED', 'Website URL is required');

  let url;
  try {
    url = new URL(raw.includes('://') ? raw : `https://${raw}`);
  } catch (_error) {
    throw buildValidationError('SITE_URL_INVALID', 'Enter a valid website URL');
  }

  if (!['http:', 'https:'].includes(url.protocol)) {
    throw buildValidationError('SITE_URL_INVALID_PROTOCOL', 'Only http and https URLs can be audited');
  }

  url.hash = '';
  if (!url.pathname) url.pathname = '/';
  return url;
}

function buildValidationError(code, message) {
  const error = new Error(message);
  error.code = code;
  error.status = 400;
  return error;
}

function isPrivateIp(address) {
  const ipVersion = net.isIP(address);
  if (!ipVersion) return false;

  if (ipVersion === 6) {
    const normalized = address.toLowerCase();
    return normalized === '::1'
      || normalized.startsWith('fc')
      || normalized.startsWith('fd')
      || normalized.startsWith('fe80:')
      || normalized === '::'
      || normalized.startsWith('::ffff:127.')
      || normalized.startsWith('::ffff:10.')
      || normalized.startsWith('::ffff:192.168.');
  }

  const parts = address.split('.').map((part) => Number(part));
  const [a, b] = parts;
  return a === 0
    || a === 10
    || a === 127
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 100 && b >= 64 && b <= 127)
    || a >= 224;
}

async function assertPublicUrl(url) {
  const hostname = url.hostname.toLowerCase();
  if (
    hostname === 'localhost'
    || hostname.endsWith('.localhost')
    || hostname.endsWith('.local')
    || hostname.endsWith('.test')
    || isPrivateIp(hostname)
  ) {
    throw buildValidationError('SITE_URL_PRIVATE', 'Private or local URLs cannot be audited');
  }

  const records = await dns.lookup(hostname, { all: true, verbatim: true }).catch((error) => {
    const wrapped = buildValidationError('SITE_URL_DNS_FAILED', 'Could not resolve that website URL');
    wrapped.cause = error;
    throw wrapped;
  });

  if (!records.length || records.some((record) => isPrivateIp(record.address))) {
    throw buildValidationError('SITE_URL_PRIVATE', 'Private or local URLs cannot be audited');
  }
}

async function fetchText(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url.toString(), {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5'
      }
    });

    if (!response.ok) {
      const error = new Error(`Fetch failed with ${response.status}`);
      error.code = 'FETCH_FAILED';
      throw error;
    }

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('text/html') && !contentType.includes('xml') && !contentType.includes('text/plain')) {
      const error = new Error('Unsupported content type');
      error.code = 'UNSUPPORTED_CONTENT_TYPE';
      throw error;
    }

    return {
      url: new URL(response.url || url.toString()),
      text: await response.text(),
      contentType
    };
  } finally {
    clearTimeout(timeout);
  }
}

function sameOriginUrl(baseUrl, href) {
  if (!href) return null;
  try {
    const next = new URL(href, baseUrl);
    if (!['http:', 'https:'].includes(next.protocol)) return null;
    if (next.origin !== baseUrl.origin) return null;
    next.hash = '';
    return next;
  } catch (_error) {
    return null;
  }
}

function uniquePush(queue, seen, url, max) {
  const key = url.toString();
  if (seen.has(key) || queue.some((entry) => entry.toString() === key)) return;
  if (seen.size + queue.length >= max) return;
  queue.push(url);
}

function extractSitemapUrls(baseUrl, xml, maxPages) {
  const urls = [];
  const matches = String(xml).matchAll(/<loc>\s*([^<]+)\s*<\/loc>/gi);
  for (const match of matches) {
    const candidate = sameOriginUrl(baseUrl, decodeXml(match[1]));
    if (candidate) urls.push(candidate);
    if (urls.length >= maxPages) break;
  }
  return urls;
}

function decodeXml(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'");
}

function extractPageData(pageUrl, html) {
  const $ = cheerio.load(html);
  const title = $('title').first().text().trim();
  const links = [];
  const images = [];

  $('a[href]').each((_index, element) => {
    const href = $(element).attr('href');
    const url = sameOriginUrl(pageUrl, href);
    if (url) links.push(url);
  });

  $('img').each((_index, element) => {
    const img = $(element);
    const src = img.attr('src') || img.attr('data-src') || img.attr('data-lazy-src') || '';
    const resolvedSrc = resolveImageUrl(pageUrl, src);
    const altAttr = img.attr('alt');
    const alt = altAttr === undefined ? null : String(altAttr);
    const filename = resolvedSrc ? resolvedSrc.split('/').pop()?.split('?')[0] || '' : '';
    const score = scoreAltText(alt, { filename });
    images.push({
      pageUrl: pageUrl.toString(),
      pageTitle: title,
      src: resolvedSrc,
      filename,
      alt,
      ...score
    });
  });

  return { title, links, images };
}

function resolveImageUrl(pageUrl, src) {
  if (!src || /^data:/i.test(src)) return '';
  try {
    return new URL(src, pageUrl).toString();
  } catch (_error) {
    return '';
  }
}

function scoreAltText(altText, { filename = '' } = {}) {
  if (altText === null || altText === undefined || String(altText).trim() === '') {
    return {
      score: 0,
      label: 'Missing',
      issues: ['Missing alt text'],
      suggestions: ['Add a concise description of what the image shows.']
    };
  }

  const alt = String(altText).trim();
  const lower = alt.toLowerCase();
  const words = lower.split(/\s+/).filter(Boolean);
  const issues = [];
  const suggestions = [];
  let score = 100;

  if (words.length <= 1) {
    score -= 45;
    issues.push('Too short to be useful');
    suggestions.push('Use a natural phrase, not a single generic word.');
  }
  if (alt.length < 8) {
    score -= 25;
    issues.push('Very short alt text');
  }
  if (alt.length > 160) {
    score -= 25;
    issues.push('Too long for comfortable screen-reader use');
    suggestions.push('Trim the alt text to the essential subject and context.');
  }
  if (/^(image|photo|picture|graphic|logo|screenshot)$/i.test(alt)) {
    score -= 55;
    issues.push('Generic alt text');
    suggestions.push('Describe the specific subject instead of using a generic label.');
  }
  if (/^(image|photo|picture|graphic|screenshot)\s+(of|showing)\b/i.test(alt)) {
    score -= 10;
    issues.push('Starts with redundant wording');
  }
  if (filename && looksLikeFilenameAlt(lower, filename)) {
    score -= 45;
    issues.push('Looks like a filename');
    suggestions.push('Rewrite filenames into human-readable descriptions.');
  }
  if (hasRepeatedWord(words)) {
    score -= 20;
    issues.push('Possible keyword stuffing');
    suggestions.push('Avoid repeating the same keyword unnaturally.');
  }
  if (/[{}[\]|\\<>]{2,}/.test(alt)) {
    score -= 20;
    issues.push('Contains characters that may confuse assistive tech');
  }

  score = Math.max(0, Math.min(100, score));
  if (score < 70 && suggestions.length === 0) {
    suggestions.push('Rewrite this as a specific, natural description of the image.');
  }

  return {
    score,
    label: score >= 85 ? 'Strong' : score >= 70 ? 'Good' : score >= 40 ? 'Needs review' : 'Poor',
    issues: [...new Set(issues)],
    suggestions: [...new Set(suggestions)]
  };
}

function looksLikeFilenameAlt(alt, filename) {
  const cleanFilename = String(filename || '')
    .replace(/\.[a-z0-9]+$/i, '')
    .replace(/[-_]+/g, ' ')
    .trim()
    .toLowerCase();
  const cleanAlt = alt.replace(/\.[a-z0-9]+$/i, '').replace(/[-_]+/g, ' ').trim().toLowerCase();
  return Boolean(cleanFilename && cleanAlt && (cleanAlt === cleanFilename || /^[a-z0-9_-]+\.(jpe?g|png|gif|webp|svg)$/i.test(alt)));
}

function hasRepeatedWord(words) {
  const counts = new Map();
  for (const word of words) {
    if (word.length < 4) continue;
    const next = (counts.get(word) || 0) + 1;
    if (next >= 4) return true;
    counts.set(word, next);
  }
  return false;
}

function summarizeAudit({ siteUrl, normalizedDomain, pages, images, maxPages, maxImages }) {
  const totalImages = images.length;
  const missing = images.filter((image) => image.alt === null || String(image.alt || '').trim() === '').length;
  const weak = images.filter((image) => image.score < 70).length;
  const strong = images.filter((image) => image.score >= 85).length;
  const averageQuality = totalImages
    ? Math.round(images.reduce((sum, image) => sum + image.score, 0) / totalImages)
    : 0;
  const coverageScore = totalImages ? Math.round(((totalImages - missing) / totalImages) * 100) : 0;
  const seoReadinessScore = totalImages ? Math.round(((totalImages - weak) / totalImages) * 100) : 0;
  const score = Math.round((coverageScore * 0.4) + (averageQuality * 0.4) + (seoReadinessScore * 0.2));
  const missingAltPercent = totalImages ? Math.round((missing / totalImages) * 100) : 0;

  const issueCounts = new Map();
  for (const image of images) {
    for (const issue of image.issues || []) {
      issueCounts.set(issue, (issueCounts.get(issue) || 0) + 1);
    }
  }

  return {
    siteUrl,
    normalizedDomain,
    score,
    pagesScanned: pages.length,
    imagesScanned: totalImages,
    missingAltCount: missing,
    missingAltPercent,
    weakAltCount: weak,
    strongAltCount: strong,
    averageQuality,
    coverageScore,
    seoReadinessScore,
    capped: pages.length >= maxPages || images.length >= maxImages,
    crawlLimits: { maxPages, maxImages },
    topIssues: [...issueCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([issue, count]) => ({ issue, count })),
    sampleImages: images
      .filter((image) => image.score < 70)
      .slice(0, 12)
      .map((image) => ({
        pageUrl: image.pageUrl,
        src: image.src,
        alt: image.alt,
        score: image.score,
        label: image.label,
        issues: image.issues
      }))
  };
}

async function crawlPublicSite(siteUrl, { maxPages = DEFAULT_MAX_PAGES, maxImages = DEFAULT_MAX_IMAGES } = {}) {
  const startUrl = normalizeAuditUrl(siteUrl);
  await assertPublicUrl(startUrl);

  const normalizedDomain = startUrl.hostname.replace(/^www\./, '').toLowerCase();
  const queue = [startUrl];
  const seen = new Set();
  const pages = [];
  const images = [];

  const sitemapUrl = new URL('/sitemap.xml', startUrl.origin);
  try {
    const sitemap = await fetchText(sitemapUrl);
    for (const url of extractSitemapUrls(startUrl, sitemap.text, maxPages)) {
      uniquePush(queue, seen, url, maxPages);
    }
  } catch (error) {
    logger.info('[image-seo-audit] sitemap skipped', {
      site_url: startUrl.toString(),
      error: error.code || error.message
    });
  }

  while (queue.length > 0 && pages.length < maxPages && images.length < maxImages) {
    const url = queue.shift();
    const key = url.toString();
    if (seen.has(key)) continue;
    seen.add(key);

    await assertPublicUrl(url);
    let fetched;
    try {
      fetched = await fetchText(url);
    } catch (error) {
      logger.warn('[image-seo-audit] page fetch failed', {
        url: key,
        error: error.code || error.message
      });
      continue;
    }

    if (fetched.url.origin !== startUrl.origin) continue;
    const page = extractPageData(fetched.url, fetched.text);
    pages.push({
      url: fetched.url.toString(),
      title: page.title,
      imageCount: page.images.length
    });

    for (const image of page.images) {
      if (images.length >= maxImages) break;
      images.push(image);
    }

    for (const link of page.links) {
      uniquePush(queue, seen, link, maxPages);
    }
  }

  return {
    siteUrl: startUrl.toString(),
    normalizedDomain,
    pages,
    images,
    summary: summarizeAudit({
      siteUrl: startUrl.toString(),
      normalizedDomain,
      pages,
      images,
      maxPages,
      maxImages
    })
  };
}

function generateAuditPdfBuffer(summary) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 48, info: { Title: 'Image SEO Audit' } });
    const chunks = [];

    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('error', reject);
    doc.on('end', () => resolve(Buffer.concat(chunks)));

    doc.fontSize(24).text('Image SEO Audit', { continued: false });
    doc.moveDown(0.4);
    doc.fontSize(11).fillColor('#4b5563').text(`Public-page audit for ${summary.normalizedDomain}`);
    doc.text(`Generated ${new Date().toLocaleDateString('en-GB')}`);
    doc.moveDown(1);

    doc.fillColor('#111827').fontSize(18).text(`Overall score: ${summary.score}/100`);
    doc.moveDown(0.5);
    doc.fontSize(11).text(`Pages scanned: ${summary.pagesScanned}`);
    doc.text(`Images found: ${summary.imagesScanned}`);
    doc.text(`Missing alt text: ${summary.missingAltCount} (${summary.missingAltPercent}%)`);
    doc.text(`Weak or review-needed alt text: ${summary.weakAltCount}`);
    doc.text(`Average alt text quality: ${summary.averageQuality}/100`);
    doc.moveDown(1);

    doc.fontSize(15).text('What to fix first');
    doc.moveDown(0.4);
    const issueLines = summary.topIssues.length
      ? summary.topIssues.map((item) => `${item.issue}: ${item.count} image${item.count === 1 ? '' : 's'}`)
      : ['No major alt text issues were found in the crawled pages.'];
    for (const line of issueLines) {
      doc.fontSize(11).text(`• ${line}`);
    }

    doc.moveDown(1);
    doc.fontSize(15).text('Sample images needing attention');
    doc.moveDown(0.4);
    if (!summary.sampleImages.length) {
      doc.fontSize(11).text('No weak sample images found in this public crawl.');
    } else {
      for (const image of summary.sampleImages.slice(0, 8)) {
        doc.fontSize(10).fillColor('#111827').text(`${image.label} (${image.score}/100)`, { continued: false });
        doc.fillColor('#4b5563').text(`Page: ${image.pageUrl}`, { width: 500 });
        doc.text(`Image: ${image.src || 'Unknown image URL'}`, { width: 500 });
        doc.text(`Alt: ${image.alt === null ? '[missing]' : image.alt || '[empty]'}`, { width: 500 });
        if (image.issues?.length) doc.text(`Issues: ${image.issues.join(', ')}`, { width: 500 });
        doc.moveDown(0.5);
      }
    }

    doc.moveDown(1);
    doc.fillColor('#111827').fontSize(15).text('Notes');
    doc.moveDown(0.4);
    doc.fillColor('#4b5563').fontSize(10).text(
      `This is a capped public-page audit, not a private WordPress media-library scan. It scanned up to ${summary.crawlLimits.maxPages} pages or ${summary.crawlLimits.maxImages} images. Install the BeepBeep AI Alt Text plugin for deeper WordPress cleanup.`
    );
    doc.end();
  });
}

async function recordAuditStatus(supabase, row) {
  if (!supabase) return;
  const payload = {
    id: row.id,
    email: row.email,
    site_url: row.siteUrl,
    normalized_domain: row.normalizedDomain,
    status: row.status,
    score: row.score ?? null,
    pages_scanned: row.pagesScanned ?? null,
    images_scanned: row.imagesScanned ?? null,
    summary_json: row.summaryJson ?? null,
    error_code: row.errorCode ?? null,
    completed_at: row.completedAt ?? null
  };
  const { error } = await supabase.from('image_seo_audit_requests').upsert(payload, { onConflict: 'id' });
  if (error) {
    logger.warn('[image-seo-audit] status persistence failed', {
      audit_id: row.id,
      status: row.status,
      error: error.message
    });
  }
}

async function runImageSeoAudit({
  supabase,
  auditId = crypto.randomUUID(),
  email,
  siteUrl,
  source = 'image_seo_audit'
}) {
  const normalizedEmail = normalizeEmail(email);
  if (!isValidEmail(normalizedEmail)) {
    throw buildValidationError('EMAIL_INVALID', 'Enter a valid email address');
  }

  const url = normalizeAuditUrl(siteUrl);
  const normalizedDomain = url.hostname.replace(/^www\./, '').toLowerCase();

  await recordAuditStatus(supabase, {
    id: auditId,
    email: normalizedEmail,
    siteUrl: url.toString(),
    normalizedDomain,
    status: 'queued'
  });

  try {
    await trackImageSeoAuditRequested({
      email: normalizedEmail,
      websiteUrl: url.toString(),
      normalizedDomain,
      auditId,
      source
    });
  } catch (error) {
    logger.warn('[image-seo-audit] requested Loops event failed', { audit_id: auditId, error: error.message });
  }

  try {
    const audit = await crawlPublicSite(url.toString());
    const pdfBuffer = await generateAuditPdfBuffer(audit.summary);
    const emailResult = await sendImageSeoAuditEmail({
      to: normalizedEmail,
      siteUrl: audit.siteUrl,
      normalizedDomain: audit.normalizedDomain,
      summary: audit.summary,
      pdfBuffer
    });

    if (!emailResult.success) {
      const error = new Error(emailResult.error || 'Failed to send audit report email');
      error.code = 'EMAIL_SEND_FAILED';
      throw error;
    }

    await recordAuditStatus(supabase, {
      id: auditId,
      email: normalizedEmail,
      siteUrl: audit.siteUrl,
      normalizedDomain: audit.normalizedDomain,
      status: 'completed',
      score: audit.summary.score,
      pagesScanned: audit.summary.pagesScanned,
      imagesScanned: audit.summary.imagesScanned,
      summaryJson: audit.summary,
      completedAt: new Date().toISOString()
    });

    try {
      await trackImageSeoAuditCompleted({
        email: normalizedEmail,
        websiteUrl: audit.siteUrl,
        normalizedDomain: audit.normalizedDomain,
        auditId,
        auditScore: audit.summary.score,
        pagesScanned: audit.summary.pagesScanned,
        imagesScanned: audit.summary.imagesScanned,
        missingAltPercent: audit.summary.missingAltPercent,
        source
      });
    } catch (error) {
      logger.warn('[image-seo-audit] completed Loops event failed', { audit_id: auditId, error: error.message });
    }

    return {
      ok: true,
      auditId,
      status: 'completed',
      summary: audit.summary,
      emailMessageId: emailResult.messageId || null
    };
  } catch (error) {
    const errorCode = error.code || 'AUDIT_FAILED';
    await recordAuditStatus(supabase, {
      id: auditId,
      email: normalizedEmail,
      siteUrl: url.toString(),
      normalizedDomain,
      status: 'failed',
      errorCode,
      completedAt: new Date().toISOString()
    });

    try {
      await trackImageSeoAuditFailed({
        email: normalizedEmail,
        websiteUrl: url.toString(),
        normalizedDomain,
        auditId,
        errorCode,
        source
      });
    } catch (loopsError) {
      logger.warn('[image-seo-audit] failed Loops event failed', { audit_id: auditId, error: loopsError.message });
    }

    throw error;
  }
}

module.exports = {
  DEFAULT_MAX_IMAGES,
  DEFAULT_MAX_PAGES,
  normalizeAuditUrl,
  normalizeEmail,
  isValidEmail,
  assertPublicUrl,
  scoreAltText,
  crawlPublicSite,
  generateAuditPdfBuffer,
  runImageSeoAudit
};
