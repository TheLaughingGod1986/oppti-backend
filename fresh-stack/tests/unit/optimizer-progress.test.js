const {
  gradeFor,
  computeWeekly,
  computeAchievements,
  ACHIEVEMENT_DEFS
} = require('../../services/optimizerProgress');

function audit(overall, cats, ageDays) {
  return {
    overallScore: overall,
    result: { overallScore: overall, categories: cats || {} },
    completedAt: new Date(Date.now() - (ageDays || 0) * 86400000).toISOString()
  };
}

describe('gradeFor', () => {
  it('maps score bands to grades', () => {
    expect(gradeFor(98)).toBe('A+');
    expect(gradeFor(91)).toBe('A');
    expect(gradeFor(84)).toBe('B+');
    expect(gradeFor(60)).toBe('C');
    expect(gradeFor(20)).toBe('D');
  });
});

describe('computeWeekly', () => {
  const usage0 = { altImagesLifetime: 0, altImagesWeek: 0, titlesWeek: 0 };

  it('returns null with no audits', () => {
    expect(computeWeekly([], usage0)).toBeNull();
  });

  it('sets a baseline message on the first audit', () => {
    const w = computeWeekly([audit(70, {})], usage0);
    expect(w.hasBaseline).toBe(false);
    expect(w.delta).toBe(0);
    expect(w.items[0]).toMatch(/Baseline audit complete/);
  });

  it('computes delta and category improvements vs a prior audit', () => {
    const latest = audit(80, { performance: { score: 90 }, seo: { score: 88 } }, 0);
    const prior = audit(72, { performance: { score: 85 }, seo: { score: 88 } }, 10);
    const w = computeWeekly([latest, prior], usage0);
    expect(w.hasBaseline).toBe(true);
    expect(w.delta).toBe(8);
    expect(w.grade).toBe('B'); // 80
    expect(w.items.join(' ')).toMatch(/Performance up 5 points/);
    expect(w.items.join(' ')).not.toMatch(/SEO/); // unchanged, below +2 threshold
  });

  it('includes real plugin activity from usage', () => {
    const w = computeWeekly([audit(80, {}), audit(78, {}, 10)], { altImagesLifetime: 500, altImagesWeek: 18, titlesWeek: 3 });
    expect(w.items).toContain('18 images fixed');
    expect(w.items).toContain('3 titles improved');
  });
});

describe('computeAchievements', () => {
  const usage = { altImagesLifetime: 214, altImagesWeek: 0, titlesWeek: 0 };

  it('returns [] with no audit', () => {
    expect(computeAchievements(null, usage)).toEqual([]);
  });

  it('computes real progress and earned state from the latest audit', () => {
    const a = audit(84, {
      images: { coverageScore: 100 },
      aiReadiness: { score: 71 },
      performance: { score: 92 },
      seo: { score: 89 },
      internalLinking: { score: 100, orphanedCount: 0 },
      schema: { score: 40 }
    });
    const ach = computeAchievements(a, usage);
    expect(ach).toHaveLength(ACHIEVEMENT_DEFS.length);

    const byTitle = Object.fromEntries(ach.map((x) => [x.title, x]));
    expect(byTitle['Accessibility Champion'].earned).toBe(true); // coverage 100
    expect(byTitle['Fast Website'].earned).toBe(true); // perf 92 >= 90
    expect(byTitle['Authority Builder'].earned).toBe(true); // 0 orphans
    expect(byTitle['AI Ready'].earned).toBe(false); // 71 < 90
    expect(byTitle['AI Ready'].progress).toBe(79); // round(71/90*100)
    expect(byTitle['100 Score Club'].progressText).toBe('84 / 100');
    expect(byTitle['1000 Images Improved'].progressText).toBe('214 / 1000');
    expect(byTitle['1000 Images Improved'].remaining).toBe('786 images remaining');
  });

  it('never exceeds 100% progress', () => {
    const a = audit(100, { images: { coverageScore: 100 }, seo: { score: 100 } });
    const ach = computeAchievements(a, { altImagesLifetime: 5000 });
    ach.forEach((x) => expect(x.progress).toBeLessThanOrEqual(100));
  });
});
