const { SIGNUP_SOURCE_VALUES, OLD_TO_NEW, normalizeSignupSource } = require('../../lib/signupSource');

describe('signupSource codes', () => {
  test('new codes are the shared fixed set', () => {
    expect(SIGNUP_SOURCE_VALUES).toEqual(['wporg', 'search', 'x', 'facebook_group', 'friend', 'other']);
  });
  test('every old code maps to a new code', () => {
    expect(OLD_TO_NEW).toEqual({
      wporg_search: 'wporg', google: 'search', ai_assistant: 'other',
      oppti_site: 'other', friend_colleague: 'friend', social: 'other'
    });
    Object.values(OLD_TO_NEW).forEach((v) => expect(SIGNUP_SOURCE_VALUES).toContain(v));
  });
  test('old code mapping to other keeps user text if given', () => {
    expect(normalizeSignupSource({ signup_source: 'social', signup_source_other: 'Reddit' }))
      .toEqual({ source: 'other', other: 'Reddit', invalid: null, legacy: 'social' });
  });
  test('blank and unknown store nothing', () => {
    expect(normalizeSignupSource({}).source).toBeNull();
    expect(normalizeSignupSource({ signup_source: 'tiktok' })).toMatchObject({ source: null, invalid: 'tiktok' });
  });
  test('the newest migration CHECK allows new and old codes', () => {
    const fs = require('fs'); const path = require('path');
    const dir = path.join(__dirname, '../../../supabase/migrations');
    const sql = fs.readFileSync(path.join(dir, fs.readdirSync(dir).filter((f) => f.includes('signup_source')).sort().pop()), 'utf8');
    [...SIGNUP_SOURCE_VALUES, ...Object.keys(OLD_TO_NEW)].forEach((c) => expect(sql).toContain(`'${c}'`));
  });
});
