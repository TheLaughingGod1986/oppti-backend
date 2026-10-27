const { buildTitleRequestFingerprint } = require('../../services/titleQuota');

describe('Titles request identity on plain WordPress permalinks', () => {
  const args = { siteKey: 'site-1', page: { id: 101, url: '/', h1: 'Same heading', content_excerpt: 'Original text' }, options: {}, previous: null };
  test('different posts sharing a path and heading never share a reservation', () => {
    expect(buildTitleRequestFingerprint(args)).not.toBe(buildTitleRequestFingerprint({ ...args, page: { ...args.page, id: 102 } }));
  });
  test('an identical retry, including numeric versus string post ID, keeps its reservation', () => {
    expect(buildTitleRequestFingerprint(args)).toBe(buildTitleRequestFingerprint({ ...args, page: { ...args.page, id: '101' } }));
  });
  test('content edits on legacy clients without a post ID create a new request', () => {
    const page = { ...args.page, id: undefined };
    expect(buildTitleRequestFingerprint({ ...args, page })).not.toBe(buildTitleRequestFingerprint({ ...args, page: { ...page, content_excerpt: 'Revised text' } }));
  });
  test('a later regeneration with different previous metadata is not mistaken for its retry', () => {
    expect(buildTitleRequestFingerprint({ ...args, previous: { title: 'First', meta: 'Description' } }))
      .not.toBe(buildTitleRequestFingerprint({ ...args, previous: { title: 'Second', meta: 'Description' } }));
  });
});
