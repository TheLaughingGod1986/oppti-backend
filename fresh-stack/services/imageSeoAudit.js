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

  /* --- Additive page signals for the optimizer audit (SEO / schema /
   * accessibility / performance). The lead-gen email flow ignores these. --- */
  const metaDescription = ($('meta[name="description"]').attr('content') || '').trim();
  const canonical = ($('link[rel="canonical"]').attr('href') || '').trim();
  const robotsMeta = ($('meta[name="robots"]').attr('content') || '').trim().toLowerCase();
  const hasOgTitle = $('meta[property="og:title"]').length > 0;
  const hasTwitterCard = $('meta[name="twitter:card"]').length > 0;
  const htmlLang = ($('html').attr('lang') || '').trim();
  const h1Count = $('h1').length;

  const jsonLdTypes = [];
  $('script[type="application/ld+json"]').each((_index, element) => {
    try {
      const parsed = JSON.parse($(element).contents().text());
      const nodes = Array.isArray(parsed) ? parsed : (parsed && parsed['@graph']) ? parsed['@graph'] : [parsed];
      for (const node of nodes) {
        const type = node && node['@type'];
        if (Array.isArray(type)) jsonLdTypes.push(...type.map(String));
        else if (type) jsonLdTypes.push(String(type));
      }
    } catch (_error) { /* malformed JSON-LD — counts as absent */ }
  });

  let unlabeledInputs = 0;
  $('input[type="text"], input[type="email"], input[type="search"], input[type="tel"], input[type="url"], input:not([type]), textarea, select').each((_index, element) => {
    const el = $(element);
    const id = el.attr('id');
    const labelled = (id && $(`label[for="${id}"]`).length > 0)
      || el.attr('aria-label') || el.attr('aria-labelledby')
      || el.parents('label').length > 0;
    if (!labelled) unlabeledInputs += 1;
  });

  let emptyLinks = 0;
  $('a[href]').each((_index, element) => {
    const el = $(element);
    const hasText = el.text().trim() !== ''
      || el.attr('aria-label')
      || el.find('img[alt]').filter((_i, img) => String($(img).attr('alt') || '').trim() !== '').length > 0;
    if (!hasText) emptyLinks += 1;
  });

  const signals = {
    metaDescription,
    canonical,
    noindex: robotsMeta.includes('noindex'),
    hasOgTitle,
    hasTwitterCard,
    htmlLang,
    h1Count,
    jsonLdTypes,
    unlabeledInputs,
    emptyLinks,
    scriptCount: $('script[src]').length,
    stylesheetCount: $('link[rel="stylesheet"]').length,
    htmlBytes: html.length
  };

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

  return { title, links, images, signals };
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

  const pagePriorityMap = new Map();
  for (const image of images) {
    const pageUrl = image.pageUrl || siteUrl;
    const current = pagePriorityMap.get(pageUrl) || {
      pageUrl,
      imageCount: 0,
      missingCount: 0,
      weakCount: 0,
      averageQualityTotal: 0
    };
    current.imageCount += 1;
    current.averageQualityTotal += image.score;
    if (image.alt === null || String(image.alt || '').trim() === '') current.missingCount += 1;
    if (image.score < 70) current.weakCount += 1;
    pagePriorityMap.set(pageUrl, current);
  }

  const problemImageMap = new Map();
  for (const image of images.filter((item) => item.score < 70)) {
    const key = `${image.src || 'unknown'}::${String(image.alt || '').trim().toLowerCase()}`;
    const current = problemImageMap.get(key) || {
      src: image.src,
      alt: image.alt,
      score: image.score,
      label: image.label,
      issues: new Set(),
      pages: new Set(),
      occurrences: 0
    };
    current.score = Math.min(current.score, image.score);
    current.occurrences += 1;
    current.pages.add(image.pageUrl);
    for (const issue of image.issues || []) current.issues.add(issue);
    problemImageMap.set(key, current);
  }

  const recommendations = buildAuditRecommendations({
    totalImages,
    missing,
    weak,
    averageQuality,
    topIssues: [...issueCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([issue, count]) => ({ issue, count }))
  });

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
    recommendations,
    scoreBand: score >= 85 ? 'Strong' : score >= 70 ? 'Good' : score >= 45 ? 'Needs work' : 'High priority',
    priorityPages: [...pagePriorityMap.values()]
      .map((page) => ({
        pageUrl: page.pageUrl,
        imageCount: page.imageCount,
        missingCount: page.missingCount,
        weakCount: page.weakCount,
        averageQuality: page.imageCount ? Math.round(page.averageQualityTotal / page.imageCount) : 0,
        opportunityScore: (page.missingCount * 3) + page.weakCount + Math.ceil(page.imageCount / 10)
      }))
      .sort((a, b) => b.opportunityScore - a.opportunityScore)
      .slice(0, 8),
    sampleImages: [...problemImageMap.values()]
      .sort((a, b) => {
        if (b.occurrences !== a.occurrences) return b.occurrences - a.occurrences;
        return a.score - b.score;
      })
      .slice(0, 12)
      .map((image) => ({
        pageUrl: [...image.pages][0],
        pages: [...image.pages].slice(0, 3),
        occurrences: image.occurrences,
        src: image.src,
        alt: image.alt,
        score: image.score,
        label: image.label,
        issues: [...image.issues]
      }))
  };
}

function buildAuditRecommendations({ totalImages, missing, weak, averageQuality, topIssues }) {
  const recommendations = [];
  if (!totalImages) {
    return [
      {
        title: 'Confirm images are crawlable',
        detail: 'The public crawl did not find visible image tags. Check whether key images are rendered by scripts, blocked by robots rules, or hidden from public pages.'
      }
    ];
  }

  if (missing > 0) {
    recommendations.push({
      title: 'Fill missing alt text first',
      detail: `${missing} image${missing === 1 ? '' : 's'} had empty or missing alt text. Start with images on commercial, article, and landing pages before decorative icons.`
    });
  }

  const filenameIssue = topIssues.find((item) => item.issue === 'Looks like a filename');
  if (filenameIssue) {
    recommendations.push({
      title: 'Replace filename-like alt text',
      detail: `${filenameIssue.count} image${filenameIssue.count === 1 ? '' : 's'} appear to use file names as alt text. Rewrite these as plain descriptions of the visible image.`
    });
  }

  const shortIssue = topIssues.find((item) => item.issue === 'Too short to be useful');
  if (shortIssue) {
    recommendations.push({
      title: 'Expand very short alt text',
      detail: `${shortIssue.count} image${shortIssue.count === 1 ? '' : 's'} had alt text that is probably too short to help search engines or screen-reader users.`
    });
  }

  if (weak > missing && averageQuality < 75) {
    recommendations.push({
      title: 'Review weak existing alt text',
      detail: 'Some images have alt text, but it is generic, repetitive, too short, or otherwise weak. These are good candidates for AI-assisted rewriting plus a quick human review.'
    });
  }

  recommendations.push({
    title: 'Use a repeatable WordPress workflow',
    detail: 'After the public-page cleanup, run a media-library scan so new uploads and older unused-but-indexable media do not keep creating the same issue.'
  });

  return recommendations.slice(0, 5);
}

async function crawlPublicSite(siteUrl, { maxPages = DEFAULT_MAX_PAGES, maxImages = DEFAULT_MAX_IMAGES, allowPrivate = false } = {}) {
  const startUrl = normalizeAuditUrl(siteUrl);
  // allowPrivate is a local-development escape hatch (wp-env sites live on
  // localhost). Callers must gate it behind an explicit env flag — never
  // expose it to request input.
  if (!allowPrivate) await assertPublicUrl(startUrl);

  const normalizedDomain = startUrl.hostname.replace(/^www\./, '').toLowerCase();
  const queue = [startUrl];
  const seen = new Set();
  const pages = [];
  const images = [];

  let sitemapFound = false;
  const sitemapUrl = new URL('/sitemap.xml', startUrl.origin);
  try {
    const sitemap = await fetchText(sitemapUrl);
    sitemapFound = true;
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

    if (!allowPrivate) await assertPublicUrl(url);
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
      imageCount: page.images.length,
      // Outbound same-origin link targets (deduped) — lets consumers build an
      // internal-link graph without re-crawling. Additive; email/PDF ignore it.
      links: [...new Set(page.links.map((link) => link.toString()))],
      // Per-page SEO/schema/a11y/perf signals for the optimizer audit.
      signals: page.signals
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
    sitemapFound,
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
    const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const marginLeft = doc.page.margins.left;
    const brand = '#7B5CFF';
    const ink = '#111827';
    const muted = '#4b5563';
    const border = '#e5e7eb';

    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('error', reject);
    doc.on('end', () => resolve(Buffer.concat(chunks)));

    function resetX() {
      doc.x = marginLeft;
    }

    function section(title) {
      ensureSpace(90);
      resetX();
      doc.moveDown(0.8);
      doc.fillColor(ink).fontSize(15).text(title);
      doc.moveTo(marginLeft, doc.y + 4).lineTo(marginLeft + pageWidth, doc.y + 4).strokeColor(border).stroke();
      doc.moveDown(0.8);
      resetX();
    }

    function ensureSpace(height) {
      if (doc.y + height > doc.page.height - doc.page.margins.bottom) {
        doc.addPage();
        resetX();
      }
    }

    doc.rect(0, 0, doc.page.width, 116).fill('#f4f1ff');
    doc.fillColor(brand).fontSize(10).text('FREE PUBLIC-PAGE REPORT', marginLeft, 34, { characterSpacing: 1.2 });
    doc.fillColor(ink).fontSize(28).text('Image SEO Audit', marginLeft, 52);
    doc.fillColor(muted).fontSize(11).text(`For ${summary.normalizedDomain}`, marginLeft, 84);
    doc.text(`Generated ${new Date().toLocaleDateString('en-GB')}`, marginLeft, 100);

    const scoreCardY = 144;
    doc.roundedRect(marginLeft, scoreCardY, pageWidth, 104, 10).fillAndStroke('#ffffff', border);
    doc.fillColor(ink).fontSize(28).text(`${summary.score}/100`, marginLeft + 22, scoreCardY + 22, { width: 132 });
    doc.fillColor(muted).fontSize(10).text(`Overall score - ${summary.scoreBand}`, marginLeft + 22, scoreCardY + 58, { width: 132 });

    const metricLeft = marginLeft + 176;
    const metricRight = marginLeft + 336;
    doc.fillColor(ink).fontSize(10).text(`Pages scanned: ${summary.pagesScanned}`, metricLeft, scoreCardY + 22, { width: 140 });
    doc.text(`Images found: ${summary.imagesScanned}`, metricLeft, scoreCardY + 44, { width: 140 });
    doc.text(`Average quality: ${summary.averageQuality}/100`, metricLeft, scoreCardY + 66, { width: 140 });
    doc.text(`Missing alt text: ${summary.missingAltCount} (${summary.missingAltPercent}%)`, metricRight, scoreCardY + 22, { width: 150 });
    doc.text(`Weak alt text: ${summary.weakAltCount}`, metricRight, scoreCardY + 44, { width: 150 });
    doc.text(`SEO readiness: ${summary.seoReadinessScore}/100`, metricRight, scoreCardY + 66, { width: 150 });
    doc.x = marginLeft;
    doc.y = scoreCardY + 120;

    section('Executive summary');
    doc.fillColor(muted).fontSize(11).text(
      `This audit scanned public pages on ${summary.normalizedDomain} and scored visible image alt text for coverage, clarity, and SEO usefulness. The score combines alt text coverage (${summary.coverageScore}/100), average alt text quality (${summary.averageQuality}/100), and SEO readiness (${summary.seoReadinessScore}/100).`,
      { width: pageWidth, lineGap: 3 }
    );
    if (summary.capped) {
      doc.moveDown(0.5);
      doc.text(`The crawl reached the configured cap of ${summary.crawlLimits.maxPages} pages or ${summary.crawlLimits.maxImages} images, so treat this as a prioritized sample rather than a full-site inventory.`, { width: pageWidth, lineGap: 3 });
    }

    section('What to fix first');
    const issueLines = summary.topIssues.length
      ? summary.topIssues.map((item) => `${item.issue}: ${item.count} image${item.count === 1 ? '' : 's'}`)
      : ['No major alt text issues were found in the crawled pages.'];
    for (const line of issueLines) {
      doc.fillColor(ink).fontSize(11).text(`- ${line}`, { width: pageWidth, lineGap: 2 });
    }

    section('Recommended action plan');
    for (const item of summary.recommendations || []) {
      ensureSpace(58);
      doc.fillColor(ink).fontSize(11).text(item.title, { width: pageWidth });
      doc.fillColor(muted).fontSize(10).text(item.detail, { width: pageWidth, lineGap: 2 });
      doc.moveDown(0.5);
    }

    section('Highest-impact pages');
    if (!summary.priorityPages?.length) {
      doc.fillColor(muted).fontSize(10).text('No page-level opportunities were found in this crawl.');
    } else {
      for (const page of summary.priorityPages.slice(0, 6)) {
        ensureSpace(48);
        doc.fillColor(ink).fontSize(10).text(page.pageUrl, { width: pageWidth });
        doc.fillColor(muted).fontSize(9).text(
          `${page.imageCount} images - ${page.missingCount} missing - ${page.weakCount} weak - average quality ${page.averageQuality}/100`,
          { width: pageWidth }
        );
        doc.moveDown(0.45);
      }
    }

    section('Grouped image examples');
    if (!summary.sampleImages.length) {
      doc.fillColor(muted).fontSize(10).text('No weak sample images found in this public crawl.');
    } else {
      for (const image of summary.sampleImages.slice(0, 10)) {
        ensureSpace(96);
        doc.fontSize(10).fillColor(ink).text(`${image.label} (${image.score}/100) - seen ${image.occurrences} time${image.occurrences === 1 ? '' : 's'}`);
        doc.fillColor(muted).fontSize(9).text(`Image: ${image.src || 'Unknown image URL'}`, { width: pageWidth });
        doc.text(`Alt: ${image.alt === null ? '[missing]' : image.alt || '[empty]'}`, { width: 500 });
        if (image.issues?.length) doc.text(`Issues: ${image.issues.join(', ')}`, { width: 500 });
        if (image.pages?.length) doc.text(`Example page: ${image.pages[0]}`, { width: pageWidth });
        doc.moveDown(0.5);
      }
    }

    section('How to write better alt text');
    const examples = [
      'Describe the visible subject and context in plain language.',
      'Keep useful alt text specific, usually under 125 characters.',
      'Avoid "image of" or "photo of" unless the format matters.',
      'Leave decorative icons empty with alt="" rather than forcing keywords.',
      'For products, include product type, material, colour, view, and key distinguishing detail.'
    ];
    for (const example of examples) {
      doc.fillColor(muted).fontSize(10).text(`- ${example}`, { width: pageWidth, lineGap: 2 });
    }

    section('Notes and next step');
    doc.fillColor(muted).fontSize(10).text(
      `This is a capped public-page audit, not a private WordPress media-library scan. It scanned up to ${summary.crawlLimits.maxPages} pages or ${summary.crawlLimits.maxImages} images. Use it to identify the highest-impact public issues, then run a WordPress media-library workflow to clean up older uploads and new images at source.`,
      { width: pageWidth, lineGap: 3 }
    );
    doc.moveDown(0.6);
    doc.fillColor(brand).fontSize(11).text('Plugin: https://wordpress.org/plugins/beepbeep-ai-alt-text-generator/', {
      link: 'https://wordpress.org/plugins/beepbeep-ai-alt-text-generator/',
      underline: true
    });
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
  fetchText,
  scoreAltText,
  crawlPublicSite,
  generateAuditPdfBuffer,
  runImageSeoAudit
};
