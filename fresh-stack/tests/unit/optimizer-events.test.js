const { detectEvents, getEvents, categoryGains, _memoryEvents } = require('../../services/optimizerEvents');

function audit(id, overall, cats, ageDays) {
  return {
    auditId: id,
    overallScore: overall,
    result: { overallScore: overall, categories: cats || {} },
    completedAt: new Date(Date.now() - (ageDays || 0) * 86400000).toISOString()
  };
}

// These tests use the in-memory fallback (supabase = null).
beforeEach(() => _memoryEvents.clear());

describe('detectEvents — milestones', () => {
  it('records only first_audit on the first audit', async () => {
    await detectEvents({ supabase: null, siteHash: 's1', current: audit('a1', 88, { images: { coverageScore: 100 } }), previous: null });
    const ms = await getEvents({ supabase: null, siteHash: 's1', type: 'milestone' });
    expect(ms).toHaveLength(1);
    expect(ms[0].label).toBe('First AI audit completed');
  });

  it('records a milestone only on a real crossing', async () => {
    const prev = audit('a1', 70, { internalLinking: { orphanedCount: 3, pagesScanned: 10 } }, 10);
    const cur = audit('a2', 82, { internalLinking: { orphanedCount: 0, pagesScanned: 10 } }, 0);
    await detectEvents({ supabase: null, siteHash: 's2', current: cur, previous: prev });
    const labels = (await getEvents({ supabase: null, siteHash: 's2', type: 'milestone' })).map((m) => m.label);
    expect(labels).toContain('Reached Grade B'); // 70 -> 82 crosses 75
    expect(labels).toContain('Passed 80');       // crosses 80
    expect(labels).toContain('No orphan pages'); // 3 -> 0
    expect(labels).not.toContain('Reached Grade A'); // 82 < 90
  });

  it('does not re-record a milestone already crossed', async () => {
    const prev = audit('a1', 82, {}, 20); // already above 80
    const cur = audit('a2', 85, {}, 0);
    await detectEvents({ supabase: null, siteHash: 's3', current: cur, previous: prev });
    const labels = (await getEvents({ supabase: null, siteHash: 's3', type: 'milestone' })).map((m) => m.label);
    expect(labels).not.toContain('Passed 80'); // was already met
  });
});

describe('detectEvents — wins', () => {
  it('records a win with gains on a meaningful score jump', async () => {
    const prev = audit('a1', 72, { seo: { score: 80 }, schema: { score: 0 } }, 10);
    const cur = audit('a2', 80, { seo: { score: 90 }, schema: { score: 40 } }, 0);
    await detectEvents({ supabase: null, siteHash: 's4', current: cur, previous: prev });
    const wins = await getEvents({ supabase: null, siteHash: 's4', type: 'win' });
    expect(wins).toHaveLength(1);
    expect(wins[0].delta).toBe('+8');
    expect(wins[0].gains).toEqual(expect.arrayContaining(['Search visibility improved', 'AI understanding increased']));
  });

  it('records no win when the jump is below threshold', async () => {
    await detectEvents({ supabase: null, siteHash: 's5', current: audit('a2', 81, {}), previous: audit('a1', 80, {}, 10) });
    expect(await getEvents({ supabase: null, siteHash: 's5', type: 'win' })).toHaveLength(0);
  });

  it('is idempotent per audit (win key = audit id)', async () => {
    const prev = audit('a1', 70, {}, 10);
    const cur = audit('a2', 78, {}, 0);
    await detectEvents({ supabase: null, siteHash: 's6', current: cur, previous: prev });
    await detectEvents({ supabase: null, siteHash: 's6', current: cur, previous: prev });
    expect(await getEvents({ supabase: null, siteHash: 's6', type: 'win' })).toHaveLength(1);
  });
});

describe('categoryGains', () => {
  it('maps improved categories to benefits, ignoring unchanged', () => {
    const gains = categoryGains(
      audit('a2', 0, { images: { score: 90 }, seo: { score: 88 } }),
      audit('a1', 0, { images: { score: 80 }, seo: { score: 88 } })
    );
    expect(gains).toContain('Accessibility improved');
    expect(gains).not.toContain('Search visibility improved');
  });
});
