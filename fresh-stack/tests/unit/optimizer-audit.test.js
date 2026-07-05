const {
  normalizePageKey,
  isContentPage,
  summarizeInternalLinking,
  summarizeSeo,
  summarizeSchema,
  summarizeAccessibility,
  summarizePerformance,
  summarizeAiReadiness
} = require('../../services/optimizerAudit');

function page(url, overrides = {}) {
  return {
    url,
    title: overrides.title ?? 'Page',
    imageCount: overrides.imageCount ?? 0,
    links: overrides.links ?? [],
    signals: {
      metaDescription: 'A description',
      canonical: url,
      noindex: false,
      hasOgTitle: true,
      hasTwitterCard: true,
      htmlLang: 'en',
      h1Count: 1,
      jsonLdTypes: [],
      unlabeledInputs: 0,
      emptyLinks: 0,
      scriptCount: 5,
      stylesheetCount: 3,
      htmlBytes: 50000,
      ...(overrides.signals || {})
    }
  };
}

describe('normalizePageKey', () => {
  it('strips hash, query and trailing slashes', () => {
    expect(normalizePageKey('https://a.com/x/?utm=1#top')).toBe('https://a.com/x');
    expect(normalizePageKey('https://a.com/')).toBe('https://a.com/');
  });
});

describe('isContentPage', () => {
  it('rejects sitemaps, login and feeds; accepts content', () => {
    expect(isContentPage('https://a.com/wp-sitemap-posts-post-1.xml')).toBe(false);
    expect(isContentPage('https://a.com/wp-login.php?x=1')).toBe(false);
    expect(isContentPage('https://a.com/blog/feed/')).toBe(false);
    expect(isContentPage('https://a.com/about')).toBe(true);
  });
});

describe('summarizeInternalLinking', () => {
  it('flags orphaned and thin pages but never the entry page', () => {
    const home = page('https://a.com/', { links: ['https://a.com/one'] });
    const one = page('https://a.com/one', { links: [] });
    const orphan = page('https://a.com/lost', { links: [] });
    const result = summarizeInternalLinking([home, one, orphan]);
    expect(result.orphanedCount).toBe(1);
    expect(result.orphanedPages[0].url).toBe('https://a.com/lost');
    expect(result.thinCount).toBe(1); // /one has 1 inbound link
    expect(result.score).toBeGreaterThan(0);
  });

  it('scores 100 for a fully linked site', () => {
    const links = ['https://a.com/', 'https://a.com/x', 'https://a.com/y', 'https://a.com/z'];
    const pages = links.map((url) => page(url, { links }));
    expect(summarizeInternalLinking(pages).score).toBe(100);
  });
});

describe('summarizeSeo', () => {
  it('counts duplicate titles and missing descriptions', () => {
    const pages = [
      page('https://a.com/', { title: 'Same' }),
      page('https://a.com/b', { title: 'Same' }),
      page('https://a.com/c', { title: 'Unique', signals: { metaDescription: '' } })
    ];
    const result = summarizeSeo(pages);
    expect(result.duplicateTitlePages).toBe(2);
    expect(result.duplicateTitleGroups).toBe(1);
    expect(result.missingDescription).toBe(1);
    expect(result.score).toBeLessThan(100);
  });
});

describe('summarizeSchema', () => {
  it('scores zero with no JSON-LD anywhere', () => {
    const result = summarizeSchema([page('https://a.com/')]);
    expect(result.score).toBe(0);
    expect(result.findings.join(' ')).toMatch(/No structured data/);
  });

  it('rewards coverage plus Organization and WebSite types', () => {
    const p = page('https://a.com/', { signals: { jsonLdTypes: ['Organization', 'WebSite'] } });
    const result = summarizeSchema([p]);
    expect(result.score).toBe(100);
    expect(result.hasOrganization).toBe(true);
  });
});

describe('summarizeAccessibility', () => {
  it('deducts for missing lang, unlabeled inputs and empty links', () => {
    const p = page('https://a.com/', { signals: { htmlLang: '', unlabeledInputs: 5, emptyLinks: 4 } });
    const result = summarizeAccessibility([p], { coverageScore: 100, missingAltCount: 0 });
    expect(result.pagesNoLang).toBe(1);
    expect(result.unlabeledInputs).toBe(5);
    expect(result.score).toBeLessThan(100);
  });
});

describe('summarizePerformance', () => {
  it('is a labeled heuristic and penalises heavy pages', () => {
    const light = summarizePerformance([page('https://a.com/')]);
    expect(light.method).toBe('heuristic');
    expect(light.score).toBe(100);

    const heavy = summarizePerformance([
      page('https://a.com/', { imageCount: 80, signals: { htmlBytes: 900000, scriptCount: 60 } })
    ]);
    expect(heavy.score).toBeLessThan(light.score);
    expect(heavy.findings.join(' ')).toMatch(/Core Web Vitals/);
  });
});

describe('summarizeAiReadiness', () => {
  it('blends schema, linking, headings, alt coverage and llms.txt', () => {
    const pages = [page('https://a.com/')];
    const result = summarizeAiReadiness({
      schema: { score: 100 },
      linking: { score: 100 },
      pages,
      imageSummary: { coverageScore: 100 },
      technical: { llmsFound: true }
    });
    expect(result.score).toBe(100);

    const weak = summarizeAiReadiness({
      schema: { score: 0 },
      linking: { score: 100 },
      pages,
      imageSummary: { coverageScore: 100 },
      technical: { llmsFound: false }
    });
    expect(weak.score).toBeLessThan(60);
    expect(weak.findings.join(' ')).toMatch(/llms\.txt/);
  });
});
