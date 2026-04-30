const fs = require('fs');
const path = require('path');

function read(relPath) {
  return fs.readFileSync(path.join(__dirname, '..', '..', '..', relPath), 'utf8');
}

describe('usage attribution assets', () => {
  test('backfill migration is idempotent (only fills NULL user_id)', () => {
    const sql = read('fresh-stack/migrations/013_backfill_usage_logs_user_id.sql');
    expect(sql).toContain('WHERE ul.user_id IS NULL');
    expect(sql).toMatch(/UPDATE public\.usage_logs ul[\s\S]*WHERE ul\.user_id IS NULL/);
  });

  test('reporting query excludes common internal/test hosts', () => {
    const sql = read('docs/USAGE_ATTRIBUTION_REPORTING.sql');
    expect(sql).toMatch(/localhost/i);
    expect(sql).toMatch(/tastewp/i);
    expect(sql).toMatch(/beepbeepaiaudit/i);
    expect(sql).toMatch(/example\.com/i);
  });
});

