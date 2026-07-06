const crypto = require('crypto');
const logger = require('../lib/logger');
const {
  normalizeAuditUrl,
  assertPublicUrl,
  fetchText,
  crawlPublicSite
} = require('./imageSeoAudit');

/**
 * Optimizer audit — the plugin-facing sibling of the lead-gen image SEO audit.
 *
 * Reuses crawlPublicSite (pages, images, alt scoring, per-page signals) and
 * computes every dashboard category from measured data:
 *
 *   images          alt-text coverage + quality (crawl; WP proxy adds library)
 *   internalLinking orphaned/thin pages from the crawled link graph
 *   seo             duplicate titles, missing descriptions, noindex, canonicals
 *   schema          JSON-LD coverage and which types exist
 *   technical       https, robots.txt, sitemap.xml, llms.txt
 *   aiReadiness     composite: schema + linking + headings + alt coverage
 *   accessibility   html lang, alt coverage, unlabeled inputs, empty links
 *   performance     page-weight heuristics (clearly labeled as estimates)
 *
 * Every category returns { available, score, summary, findings[] } plus its
 * raw stats; opportunities are generated from the same measurements.
 */

function normalizePageKey(url) {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    parsed.search = '';
    let path = parsed.pathname.replace(/\/+$/, '');
    if (path === '') path = '/';
    return `${parsed.origin}${path}`;
  } catch (_error) {
    return url;
  }
}

/* Crawled URLs that aren't content pages — sitemaps, login, feeds, assets —
 * would otherwise skew page-based scores. */
const NON_CONTENT_URL_RE = /\.(xml|xsl|txt|pdf|jpe?g|png|gif|webp|svg|ico|css|js)([?#]|$)|\/wp-(login|admin|json|cron)\b|\/xmlrpc\.php|\/feed\/?([?#]|$)/i;

function isContentPage(url) {
  return !NON_CONTENT_URL_RE.test(url);
}

function clampScore(value) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function pct(part, whole) {
  return whole > 0 ? part / whole : 0;
}

/* ---------------- category analyzers ---------------- */

function summarizeInternalLinking(pages) {
  const pageKeys = new Set(pages.map((page) => normalizePageKey(page.url)));
  const inboundCounts = new Map([...pageKeys].map((key) => [key, 0]));

  for (const page of pages) {
    const fromKey = normalizePageKey(page.url);
    for (const target of page.links || []) {
      const toKey = normalizePageKey(target);
      if (toKey === fromKey) continue;
      if (!inboundCounts.has(toKey)) continue;
      inboundCounts.set(toKey, inboundCounts.get(toKey) + 1);
    }
  }

  const pagesScanned = pages.length;
  const orphaned = [];
  const thin = [];
  for (const page of pages) {
    const key = normalizePageKey(page.url);
    const inbound = inboundCounts.get(key) || 0;
    const isEntry = pages.length > 0 && normalizePageKey(pages[0].url) === key;
    if (inbound === 0 && !isEntry) orphaned.push({ url: page.url, title: page.title, inbound });
    else if (inbound > 0 && inbound < 3) thin.push({ url: page.url, title: page.title, inbound });
  }

  const linkedWell = Math.max(0, pagesScanned - orphaned.length - thin.length);
  const score = pagesScanned
    ? clampScore(((linkedWell + (thin.length * 0.5)) / pagesScanned) * 100)
    : 0;

  const findings = [];
  if (orphaned.length > 0) findings.push(`${orphaned.length} pages have no other pages linking to them`);
  if (thin.length > 0) findings.push(`${thin.length} pages have fewer than 3 links from your own site`);
  if (!findings.length) findings.push(`No orphaned pages found across ${pagesScanned} crawled pages`);

  return {
    available: true,
    score,
    summary: orphaned.length > 0
      ? `${orphaned.length} pages have no links pointing to them, so authority never reaches them.`
      : `Internal linking looks healthy across ${pagesScanned} crawled pages.`,
    findings,
    pagesScanned,
    orphanedCount: orphaned.length,
    thinCount: thin.length,
    orphanedPages: orphaned.slice(0, 25),
    thinPages: thin.slice(0, 25)
  };
}

function summarizeSeo(pages) {
  const total = pages.length;
  const titleGroups = new Map();
  let missingDescription = 0;
  let noindexPages = 0;
  let missingCanonical = 0;
  let missingOg = 0;

  for (const page of pages) {
    const s = page.signals || {};
    const title = (page.title || '').trim().toLowerCase();
    if (title) titleGroups.set(title, (titleGroups.get(title) || 0) + 1);
    if (!s.metaDescription) missingDescription += 1;
    if (s.noindex) noindexPages += 1;
    if (!s.canonical) missingCanonical += 1;
    if (!s.hasOgTitle) missingOg += 1;
  }

  const duplicateTitlePages = [...titleGroups.values()].filter((n) => n > 1).reduce((sum, n) => sum + n, 0);
  const duplicateTitleGroups = [...titleGroups.entries()].filter(([, n]) => n > 1).length;

  const score = clampScore(
    100
    - (pct(duplicateTitlePages, total) * 35)
    - (pct(missingDescription, total) * 30)
    - (pct(noindexPages, total) * 100 * 0.15)
    - (pct(missingCanonical, total) * 10)
    - (pct(missingOg, total) * 10)
  );

  const findings = [];
  if (duplicateTitlePages > 0) findings.push(`${duplicateTitlePages} pages share a title with another page (${duplicateTitleGroups} duplicate groups)`);
  if (missingDescription > 0) findings.push(`${missingDescription} pages have no meta description under their search result`);
  if (noindexPages > 0) findings.push(`${noindexPages} pages tell search engines not to list them (noindex)`);
  if (missingCanonical > 0) findings.push(`${missingCanonical} pages have no canonical URL`);
  if (missingOg > 0) findings.push(`${missingOg} pages have no Open Graph tags for link sharing`);
  if (!findings.length) findings.push(`Titles, descriptions and canonicals look healthy across ${total} pages`);

  return {
    available: true,
    score,
    summary: duplicateTitlePages > 0
      ? `${duplicateTitlePages} pages compete for the same clicks with duplicate titles.`
      : missingDescription > 0
        ? `${missingDescription} pages are missing the description shown under search results.`
        : `Search fundamentals look strong across ${total} crawled pages.`,
    findings,
    pagesScanned: total,
    duplicateTitlePages,
    duplicateTitleGroups,
    missingDescription,
    noindexPages,
    missingCanonical,
    missingOg
  };
}

function summarizeSchema(pages) {
  const total = pages.length;
  let pagesWithSchema = 0;
  const typeCounts = new Map();

  for (const page of pages) {
    // schemaTypes covers JSON-LD + microdata + RDFa; jsonLdTypes kept as the
    // fallback for results produced by older crawler versions.
    const s = page.signals || {};
    const types = s.schemaTypes || s.jsonLdTypes || [];
    if (types.length > 0) pagesWithSchema += 1;
    for (const type of types) typeCounts.set(type, (typeCounts.get(type) || 0) + 1);
  }

  const has = (t) => typeCounts.has(t);
  const hasOrg = has('Organization') || has('LocalBusiness');
  const hasWebSite = has('WebSite');
  const hasFaq = has('FAQPage');

  const score = clampScore((pct(pagesWithSchema, total) * 70) + (hasOrg ? 15 : 0) + (hasWebSite ? 15 : 0));

  const findings = [];
  if (pagesWithSchema === 0) findings.push('No structured data (JSON-LD, microdata or RDFa) found on any crawled page');
  else findings.push(`${pagesWithSchema} of ${total} pages carry structured data (${[...typeCounts.keys()].slice(0, 5).join(', ')})`);
  if (!hasOrg) findings.push('Google doesn’t know your organisation’s name, logo or socials (no Organization schema)');
  if (!hasWebSite) findings.push('No WebSite schema, so sitelinks search box and site name are not controlled');
  if (!hasFaq) findings.push('No FAQ markup found, so FAQs can’t appear in Google rich results');

  return {
    available: true,
    score,
    summary: pagesWithSchema === 0
      ? 'Your pages don’t tell AI and search engines what they contain, so you miss rich results.'
      : `${pagesWithSchema} of ${total} pages carry structured data.`,
    findings,
    pagesScanned: total,
    pagesWithSchema,
    types: [...typeCounts.keys()].slice(0, 12),
    hasOrganization: hasOrg,
    hasWebSite,
    hasFaqPage: hasFaq
  };
}

async function summarizeTechnical({ startUrl, sitemapFound, allowPrivate }) {
  const https = startUrl.protocol === 'https:';
  const probe = async (path) => {
    try {
      await fetchText(new URL(path, startUrl.origin));
      return true;
    } catch (_error) {
      return false;
    }
  };
  const robotsFound = await probe('/robots.txt');
  const llmsFound = await probe('/llms.txt');
  // WordPress serves /wp-sitemap.xml when /sitemap.xml is absent.
  const sitemap = sitemapFound || await probe('/wp-sitemap.xml');

  const score = clampScore((https ? 40 : 0) + (robotsFound ? 20 : 0) + (sitemap ? 25 : 0) + (llmsFound ? 15 : 0));

  const findings = [];
  if (!https) findings.push('Site is not served over HTTPS');
  if (!robotsFound) findings.push('No robots.txt file, so crawlers get no guidance');
  if (!sitemap) findings.push('No XML sitemap found, so search engines may miss pages');
  if (!llmsFound) findings.push('No llms.txt file, so AI crawlers get no guidance');
  if (!findings.length) findings.push('HTTPS, robots.txt, sitemap and llms.txt are all in place');

  return {
    available: true,
    score,
    summary: findings.length === 1 && llmsFound
      ? 'Foundations are solid: HTTPS, robots, sitemap and llms.txt all present.'
      : !llmsFound && https && robotsFound && sitemap
        ? 'Foundations are healthy. One file for AI crawlers (llms.txt) is missing.'
        : 'Some technical foundations need attention.',
    findings,
    https,
    robotsFound,
    sitemapFound: sitemap,
    llmsFound,
    checkedPrivately: Boolean(allowPrivate)
  };
}

function summarizeAccessibility(pages, imageSummary) {
  const total = pages.length;
  let pagesNoLang = 0;
  let unlabeledInputs = 0;
  let emptyLinks = 0;
  let pagesNoH1 = 0;

  for (const page of pages) {
    const s = page.signals || {};
    if (!s.htmlLang) pagesNoLang += 1;
    unlabeledInputs += s.unlabeledInputs || 0;
    emptyLinks += s.emptyLinks || 0;
    if ((s.h1Count || 0) === 0) pagesNoH1 += 1;
  }

  const altCoverage = (imageSummary.coverageScore || 0) / 100;

  const score = clampScore(
    100
    - (pct(pagesNoLang, total) * 20)
    - ((1 - altCoverage) * 40)
    - (Math.min(unlabeledInputs, 10) * 2)
    - (Math.min(emptyLinks, 20) * 1)
    - (pct(pagesNoH1, total) * 10)
  );

  const findings = [];
  if (imageSummary.missingAltCount > 0) findings.push(`${imageSummary.missingAltCount} images have no alt text for screen readers`);
  if (pagesNoLang > 0) findings.push(`${pagesNoLang} pages don’t declare a language, confusing screen readers`);
  if (unlabeledInputs > 0) findings.push(`${unlabeledInputs} form fields don’t say what they’re for`);
  if (emptyLinks > 0) findings.push(`${emptyLinks} links have no text for assistive technology`);
  if (pagesNoH1 > 0) findings.push(`${pagesNoH1} pages have no main heading (h1)`);
  if (!findings.length) findings.push(`No accessibility issues detected across ${total} crawled pages`);

  return {
    available: true,
    score,
    summary: findings.length === 1 && !imageSummary.missingAltCount
      ? `Accessibility looks strong across ${total} crawled pages.`
      : 'Some visitors will struggle: assistive technology needs these fixes.',
    findings,
    pagesScanned: total,
    pagesNoLang,
    unlabeledInputs,
    emptyLinks,
    pagesNoH1
  };
}

/* ---- Real Core Web Vitals via Google PageSpeed Insights ----
 * Used when PAGESPEED_API_KEY is set (values of ~12 chars or fewer are
 * treated as a keyless dev sentinel — Google allows low-volume keyless
 * calls). Any failure falls back to the page-weight heuristic. PSI can only
 * measure public URLs, so localhost dev audits always use the heuristic. */
const PSI_ENDPOINT = 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed';
const PSI_TIMEOUT_MS = 45000;

async function fetchPageSpeed(siteUrl) {
  const key = process.env.PAGESPEED_API_KEY;
  if (!key) return null;
  const params = new URLSearchParams({ url: siteUrl, strategy: 'mobile', category: 'performance' });
  if (key.length > 12) params.set('key', key);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PSI_TIMEOUT_MS);
  try {
    const res = await fetch(`${PSI_ENDPOINT}?${params.toString()}`, { signal: controller.signal });
    if (!res.ok) throw new Error(`PSI responded ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function summarizePerformanceFromPsi(psi) {
  const lh = psi && psi.lighthouseResult;
  const perfCategory = lh && lh.categories && lh.categories.performance;
  if (!lh || !perfCategory || perfCategory.score == null) return null;

  const score = clampScore(perfCategory.score * 100);
  const audits = lh.audits || {};
  const display = (id) => (audits[id] && audits[id].displayValue) || null;
  const findings = [];
  const flag = (id, label) => {
    const audit = audits[id];
    if (audit && audit.score != null && audit.score < 0.9 && audit.displayValue) {
      findings.push(`${label}: ${audit.displayValue}`);
    }
  };
  flag('largest-contentful-paint', 'Largest Contentful Paint');
  flag('cumulative-layout-shift', 'Layout shift (CLS)');
  flag('total-blocking-time', 'Total blocking time');
  flag('first-contentful-paint', 'First Contentful Paint');
  if (!findings.length) findings.push('Core Web Vitals look healthy on mobile');
  findings.push('Measured with Google Lighthouse (mobile)');

  return {
    available: true,
    method: 'lighthouse',
    score,
    summary: score >= 90
      ? 'Core Web Vitals look strong on mobile.'
      : score >= 50
        ? 'Core Web Vitals need attention on mobile.'
        : 'Core Web Vitals are poor on mobile.',
    findings,
    metrics: {
      lcp: display('largest-contentful-paint'),
      cls: display('cumulative-layout-shift'),
      tbt: display('total-blocking-time'),
      fcp: display('first-contentful-paint')
    }
  };
}

function summarizePerformance(pages) {
  const total = pages.length;
  if (total === 0) {
    return { available: true, method: 'heuristic', score: 0, summary: 'No pages crawled.', findings: [], pagesScanned: 0 };
  }

  const avg = (fn) => pages.reduce((sum, p) => sum + fn(p.signals || {}), 0) / total;
  const avgBytes = avg((s) => s.htmlBytes || 0);
  const avgScripts = avg((s) => s.scriptCount || 0);
  const avgStylesheets = avg((s) => s.stylesheetCount || 0);
  const avgImages = pages.reduce((sum, p) => sum + (p.imageCount || 0), 0) / total;

  const heavyHtml = Math.max(0, (avgBytes - 120000) / 120000); // over ~120KB HTML
  const heavyScripts = Math.max(0, (avgScripts - 15) / 15);
  const heavyImages = Math.max(0, (avgImages - 25) / 25);

  const score = clampScore(100 - (heavyHtml * 25) - (heavyScripts * 20) - (heavyImages * 15) - Math.max(0, avgStylesheets - 10));

  const findings = [];
  if (avgBytes > 120000) findings.push(`Average page HTML is ${Math.round(avgBytes / 1024)}KB — heavy documents slow first paint`);
  if (avgScripts > 15) findings.push(`Pages load ${Math.round(avgScripts)} scripts on average`);
  if (avgImages > 25) findings.push(`Pages contain ${Math.round(avgImages)} images on average`);
  if (!findings.length) findings.push(`Page weight looks reasonable (avg ${Math.round(avgBytes / 1024)}KB HTML, ${Math.round(avgScripts)} scripts)`);
  findings.push('Estimated from page structure — full Core Web Vitals measurement coming soon');

  return {
    available: true,
    method: 'heuristic',
    score,
    summary: score >= 80
      ? 'Page weight looks healthy. Estimates only — full Core Web Vitals coming soon.'
      : 'Heavy pages detected. Estimates only — full Core Web Vitals coming soon.',
    findings,
    pagesScanned: total,
    avgHtmlKb: Math.round(avgBytes / 1024),
    avgScripts: Math.round(avgScripts),
    avgImagesPerPage: Math.round(avgImages)
  };
}

function summarizeAiReadiness({ schema, linking, pages, imageSummary, technical }) {
  const total = pages.length;
  const pagesWithH1 = pages.filter((p) => ((p.signals || {}).h1Count || 0) > 0).length;
  const headingScore = clampScore(pct(pagesWithH1, total) * 100);

  const score = clampScore(
    (schema.score * 0.35)
    + (linking.score * 0.25)
    + (headingScore * 0.15)
    + ((imageSummary.coverageScore || 0) * 0.15)
    + ((technical.llmsFound ? 100 : 0) * 0.10)
  );

  const findings = [];
  if (schema.score < 60) findings.push('Structured data is thin, so AI assistants can’t map what your pages contain');
  if (linking.score < 60) findings.push('Topics aren’t clearly connected, so AI can’t map your expertise');
  if (headingScore < 80) findings.push(`${total - pagesWithH1} pages lack a clear main heading for AI to anchor on`);
  if ((imageSummary.coverageScore || 0) < 80) findings.push('Undescribed images hide content from AI assistants');
  if (!technical.llmsFound) findings.push('No llms.txt file, so AI crawlers get no guidance');
  if (!findings.length) findings.push('Schema, linking, headings and image descriptions all support AI understanding');

  return {
    available: true,
    score,
    summary: score >= 80
      ? 'AI assistants can read and map your site well.'
      : 'AI assistants struggle to map your expertise from the current structure.',
    findings,
    pagesScanned: total,
    headingScore,
    componentScores: {
      schema: schema.score,
      linking: linking.score,
      headings: headingScore,
      imageCoverage: imageSummary.coverageScore || 0,
      llmsTxt: technical.llmsFound ? 100 : 0
    }
  };
}

/* ---------------- opportunities + composition ---------------- */

function buildOpportunities({ images, linking, seo, schema, technical, accessibility }) {
  const ops = [];
  if ((images.missingAltCount || 0) > 0 || (images.weakAltCount || 0) > 0) {
    const missing = images.missingAltCount || 0;
    ops.push({
      cat: 'images',
      level: missing > 0 ? 'critical' : 'warn',
      issue: 'Generate missing image descriptions',
      detail: missing > 0 ? `${missing} images missing descriptions` : `${images.weakAltCount} images with weak descriptions`,
      points: Math.max(1, Math.round((100 - images.score) / 10)),
      time: '2 min'
    });
  }
  if ((linking.orphanedCount || 0) > 0 || (linking.thinCount || 0) > 0) {
    ops.push({
      cat: 'linking',
      level: linking.orphanedCount > 0 ? 'critical' : 'warn',
      issue: 'Connect isolated pages',
      detail: linking.orphanedCount > 0 ? `${linking.orphanedCount} pages no one links to` : `${linking.thinCount} pages need more internal links`,
      points: Math.max(1, Math.round((100 - linking.score) / 10)),
      time: '4 min'
    });
  }
  if ((seo.duplicateTitlePages || 0) > 0 || (seo.missingDescription || 0) > 0) {
    ops.push({
      cat: 'seo',
      level: 'warn',
      issue: seo.duplicateTitlePages > 0 ? 'Remove duplicate page titles' : 'Write missing meta descriptions',
      detail: seo.duplicateTitlePages > 0 ? `${seo.duplicateTitlePages} pages share the same title` : `${seo.missingDescription} pages have no description`,
      points: Math.max(1, Math.round((100 - seo.score) / 12)),
      time: '2 min'
    });
  }
  if (!schema.hasFaqPage || schema.pagesWithSchema === 0) {
    ops.push({
      cat: 'schema',
      level: 'warn',
      issue: schema.pagesWithSchema === 0 ? 'Add structured data' : 'Make FAQs visible to Google',
      detail: schema.pagesWithSchema === 0 ? 'No JSON-LD found on any page' : 'FAQ markup is missing',
      points: Math.max(1, Math.round((100 - schema.score) / 15)),
      time: '3 min'
    });
  }
  if (!technical.llmsFound) {
    ops.push({
      cat: 'tech',
      level: 'info',
      issue: 'Add an llms.txt file',
      detail: 'AI crawlers currently get no guidance',
      points: 2,
      time: '5 min'
    });
  }
  if ((accessibility.unlabeledInputs || 0) > 0 || (accessibility.pagesNoLang || 0) > 0) {
    ops.push({
      cat: 'access',
      level: 'info',
      issue: 'Fix accessibility basics',
      detail: accessibility.unlabeledInputs > 0
        ? `${accessibility.unlabeledInputs} form fields need labels`
        : `${accessibility.pagesNoLang} pages need a language attribute`,
      points: 2,
      time: '5 min'
    });
  }
  return ops.sort((a, b) => b.points - a.points);
}

const CATEGORY_WEIGHTS = {
  images: 0.20,
  internalLinking: 0.15,
  seo: 0.20,
  schema: 0.10,
  aiReadiness: 0.10,
  technical: 0.10,
  performance: 0.10,
  accessibility: 0.05
};

async function buildOptimizerResult({ startUrl, crawl, allowPrivate, psi = null }) {
  const contentPages = crawl.pages.filter((page) => isContentPage(page.url));
  const imageSummary = crawl.summary;

  const linking = summarizeInternalLinking(contentPages);
  const seo = summarizeSeo(contentPages);
  const schema = summarizeSchema(contentPages);
  const technical = await summarizeTechnical({ startUrl, sitemapFound: crawl.sitemapFound, allowPrivate });
  const accessibility = summarizeAccessibility(contentPages, imageSummary);
  const performance = summarizePerformanceFromPsi(psi) || summarizePerformance(contentPages);
  const aiReadiness = summarizeAiReadiness({ schema, linking, pages: contentPages, imageSummary, technical });

  const images = {
    available: true,
    score: imageSummary.score,
    summary: imageSummary.missingAltCount > 0
      ? `${imageSummary.missingAltCount} of ${imageSummary.imagesScanned} images are invisible to search engines and screen readers.`
      : `All ${imageSummary.imagesScanned} images found on public pages have descriptions.`,
    findings: (() => {
      const f = [];
      if (imageSummary.missingAltCount > 0) f.push(`${imageSummary.missingAltCount} images have no description for search engines or screen readers`);
      if (imageSummary.weakAltCount > 0) f.push(`${imageSummary.weakAltCount} images have weak or unhelpful descriptions`);
      if (!f.length) f.push(`All ${imageSummary.imagesScanned} images found on public pages have descriptions`);
      return f;
    })(),
    missingAltCount: imageSummary.missingAltCount,
    missingAltPercent: imageSummary.missingAltPercent,
    weakAltCount: imageSummary.weakAltCount,
    strongAltCount: imageSummary.strongAltCount,
    averageQuality: imageSummary.averageQuality,
    coverageScore: imageSummary.coverageScore,
    seoReadinessScore: imageSummary.seoReadinessScore,
    topIssues: imageSummary.topIssues,
    recommendations: imageSummary.recommendations,
    pagePriorities: imageSummary.pagePriorities,
    problemImages: imageSummary.problemImages
  };

  const categories = { images, internalLinking: linking, seo, schema, aiReadiness, technical, performance, accessibility };

  let overall = 0;
  for (const [key, weight] of Object.entries(CATEGORY_WEIGHTS)) {
    overall += (categories[key].score || 0) * weight;
  }

  const opportunities = buildOpportunities({ images, linking, seo, schema, technical, accessibility });
  const issuesFound = opportunities.length
    + (seo.noindexPages > 0 ? 1 : 0);

  return {
    siteUrl: crawl.siteUrl,
    normalizedDomain: crawl.normalizedDomain,
    completedAt: new Date().toISOString(),
    overallScore: clampScore(overall),
    pagesScanned: contentPages.length,
    imagesScanned: imageSummary.imagesScanned,
    crawlLimits: imageSummary.crawlLimits,
    capped: imageSummary.capped,
    issuesFound,
    categories,
    opportunities
  };
}

/**
 * Audit store: in-memory for fast same-instance polling, mirrored to the
 * optimizer_audits table (best-effort) so history and results survive
 * restarts and serve the Progress screen.
 */
const MAX_STORED_AUDITS = 200;
const auditStore = new Map();

function pruneStore() {
  while (auditStore.size > MAX_STORED_AUDITS) {
    const oldestKey = auditStore.keys().next().value;
    auditStore.delete(oldestKey);
  }
}

async function persistAudit(supabase, record) {
  if (!supabase) return;
  const payload = {
    id: record.auditId,
    site_hash: record.siteHash,
    site_url: record.siteUrl,
    normalized_domain: record.normalizedDomain || null,
    status: record.status,
    overall_score: record.result ? record.result.overallScore : null,
    pages_scanned: record.result ? record.result.pagesScanned : null,
    images_scanned: record.result ? record.result.imagesScanned : null,
    result_json: record.result || null,
    error_code: record.errorCode,
    completed_at: record.status === 'running' ? null : new Date().toISOString()
  };
  const { error } = await supabase.from('optimizer_audits').upsert(payload, { onConflict: 'id' });
  if (error) {
    logger.warn('[optimizer-audit] persistence failed', {
      audit_id: record.auditId,
      status: record.status,
      error: error.message
    });
  }
}

function startOptimizerAudit({ siteUrl, siteHash = null, supabase = null }) {
  const url = normalizeAuditUrl(siteUrl);
  const auditId = crypto.randomUUID();
  const record = {
    auditId,
    siteHash,
    siteUrl: url.toString(),
    normalizedDomain: url.hostname.replace(/^www\./, '').toLowerCase(),
    status: 'running',
    startedAt: new Date().toISOString(),
    result: null,
    errorCode: null
  };
  auditStore.set(auditId, record);
  pruneStore();

  // Local-development escape hatch: wp-env sites live on localhost, which the
  // SSRF guard rightly blocks in production. Opt in explicitly via env only.
  const allowPrivate = process.env.OPTIMIZER_ALLOW_PRIVATE_URLS === 'true';

  (async () => {
    await persistAudit(supabase, record);
    try {
      if (!allowPrivate) await assertPublicUrl(url);
      // PSI runs in parallel with the crawl; failures degrade to the heuristic.
      const psiPromise = fetchPageSpeed(url.toString()).catch((error) => {
        logger.info('[optimizer-audit] PageSpeed unavailable, using heuristic', {
          audit_id: auditId,
          error: error.message
        });
        return null;
      });
      const crawl = await crawlPublicSite(url.toString(), { allowPrivate });
      record.result = await buildOptimizerResult({ startUrl: url, crawl, allowPrivate, psi: await psiPromise });
      record.status = 'completed';
    } catch (error) {
      record.status = 'failed';
      record.errorCode = error.code || 'AUDIT_FAILED';
      logger.warn('[optimizer-audit] audit failed', {
        audit_id: auditId,
        site_url: record.siteUrl,
        error: error.message,
        code: record.errorCode
      });
    }
    await persistAudit(supabase, record);
  })();

  return record;
}

async function getOptimizerAudit(auditId, { supabase = null } = {}) {
  const inMemory = auditStore.get(auditId);
  if (inMemory) return inMemory;
  if (!supabase) return null;

  // Fallback: another instance ran it, or this one restarted.
  const { data, error } = await supabase
    .from('optimizer_audits')
    .select('id, site_hash, site_url, status, overall_score, result_json, error_code, created_at, completed_at')
    .eq('id', auditId)
    .maybeSingle();
  if (error || !data) return null;
  return {
    auditId: data.id,
    siteHash: data.site_hash,
    siteUrl: data.site_url,
    status: data.status,
    startedAt: data.created_at,
    result: data.result_json,
    errorCode: data.error_code
  };
}

/**
 * Completed audits for one site, newest first — powers the Progress screen.
 * Falls back to this instance's memory when the DB is unavailable (dev).
 */
async function getOptimizerHistory({ siteHash, supabase = null, limit = 12 }) {
  if (!siteHash) return [];
  if (supabase) {
    const { data, error } = await supabase
      .from('optimizer_audits')
      .select('id, site_url, status, overall_score, pages_scanned, images_scanned, created_at, completed_at')
      .eq('site_hash', siteHash)
      .eq('status', 'completed')
      .order('created_at', { ascending: false })
      .limit(limit);
    if (!error && data) {
      return data.map((row) => ({
        auditId: row.id,
        siteUrl: row.site_url,
        overallScore: row.overall_score,
        pagesScanned: row.pages_scanned,
        imagesScanned: row.images_scanned,
        completedAt: row.completed_at || row.created_at
      }));
    }
    logger.warn('[optimizer-audit] history query failed', { site_hash: siteHash, error: error && error.message });
  }
  return [...auditStore.values()]
    .filter((r) => r.siteHash === siteHash && r.status === 'completed' && r.result)
    .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))
    .slice(0, limit)
    .map((r) => ({
      auditId: r.auditId,
      siteUrl: r.siteUrl,
      overallScore: r.result.overallScore,
      pagesScanned: r.result.pagesScanned,
      imagesScanned: r.result.imagesScanned,
      completedAt: r.result.completedAt
    }));
}

module.exports = {
  normalizePageKey,
  isContentPage,
  summarizeInternalLinking,
  summarizeSeo,
  summarizeSchema,
  summarizeTechnical,
  summarizeAccessibility,
  summarizePerformance,
  summarizePerformanceFromPsi,
  summarizeAiReadiness,
  buildOptimizerResult,
  startOptimizerAudit,
  getOptimizerAudit,
  getOptimizerHistory
};
