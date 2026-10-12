const {
  normalizeAuditorFinding,
  buildSignupAttribution,
  recordSignupAttribution,
  AUDITOR_FINDING_IDS
} = require('../../services/auditorAttribution');

describe('auditor sign-up attribution', () => {
  test.each(AUDITOR_FINDING_IDS)('stores new id %s as-is', (id) => {
    expect(normalizeAuditorFinding({ finding: id })).toBe(id);
  });

  // The fixture must be synced from check_categories() in the Auditor's
  // includes/check-copy.php (plus any newer checks such as title_too_long).
  test('allow-list equals the canonical Auditor check-id fixture exactly', () => {
    const fixture = require('../fixtures/auditor-check-ids.json');
    expect([...AUDITOR_FINDING_IDS]).toEqual(fixture);
    expect(new Set(AUDITOR_FINDING_IDS).size).toBe(AUDITOR_FINDING_IDS.length);
  });

  test('title_too_long is stored', () => {
    expect(normalizeAuditorFinding({ finding: 'title_too_long' })).toBe('title_too_long');
  });

  test.each([
    ['search_indexing', 'search_engines_discouraged'],
    ['https', 'https_not_enforced'],
    ['sitemap', 'sitemap_missing'],
    ['canonical', 'canonical_missing'],
    ['open_graph', 'og_tags_missing']
  ])('maps old id %s to %s', (oldId, newId) => {
    expect(normalizeAuditorFinding({ finding: oldId })).toBe(newId);
    expect(normalizeAuditorFinding({ auditor_source: oldId })).toBe(newId);
  });

  test.each([
    ['unknown id', 'internal_links'],
    ['empty', ''],
    ['number', 42],
    ['object', { id: 'missing_alt' }],
    ['array', ['missing_alt']],
    ['null', null],
    ['boolean', true]
  ])('drops %s', (_label, value) => {
    expect(normalizeAuditorFinding({ finding: value })).toBeNull();
  });

  test('64-character cap applies to the raw value', () => {
    expect(normalizeAuditorFinding({ finding: 'missing_alt' + ' '.repeat(53) })).toBe('missing_alt'); // 64
    expect(normalizeAuditorFinding({ finding: 'missing_alt' + ' '.repeat(54) })).toBeNull(); // 65
    expect(normalizeAuditorFinding({ finding: 'x'.repeat(71) })).toBeNull();
  });

  test('prefers finding, falls back to auditor_source', () => {
    expect(normalizeAuditorFinding({ finding: 'sitemap_missing', auditor_source: 'https' })).toBe('sitemap_missing');
    expect(normalizeAuditorFinding({ finding: 'garbage', auditor_source: 'https' })).toBe('https_not_enforced');
    expect(normalizeAuditorFinding({ auditor_source: 'missing_alt' })).toBe('missing_alt');
  });

  test('flag is true only when a valid finding is stored', () => {
    expect(buildSignupAttribution({ finding: 'missing_alt' })).toEqual({ auditor_finding: 'missing_alt', signup_source_auditor: true });
    expect(buildSignupAttribution({ finding: 'nope' })).toEqual({ auditor_finding: null, signup_source_auditor: false });
    expect(buildSignupAttribution({})).toEqual({ auditor_finding: null, signup_source_auditor: false });
    expect(buildSignupAttribution(undefined)).toEqual({ auditor_finding: null, signup_source_auditor: false });
  });

  test('never throws when the DB write errors or throws', async () => {
    const errSupabase = { from: () => ({ update: () => ({ eq: async () => ({ error: { message: 'column "auditor_finding" does not exist' } }) }) }) };
    await expect(recordSignupAttribution({ supabase: errSupabase, userId: 'u1', pluginId: 'titles', body: { finding: 'https' } }))
      .resolves.toMatchObject({ signup_plugin: 'titles', auditor_finding: 'https_not_enforced' });
    const throwSupabase = { from: () => { throw new Error('boom'); } };
    await expect(recordSignupAttribution({ supabase: throwSupabase, userId: 'u1', pluginId: 'alt_text', body: {} }))
      .resolves.toMatchObject({ signup_source_auditor: false });
  });
});
