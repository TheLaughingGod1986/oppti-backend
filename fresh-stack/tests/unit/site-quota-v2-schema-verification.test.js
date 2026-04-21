const { parseSupabaseDryRunConnection } = require('../../scripts/verify-site-quota-v2-schema');

describe('verify-site-quota-v2-schema', () => {
  it('parses the temporary linked-project connection details from Supabase dry-run output', () => {
    const sample = [
      'Initialising login role...',
      'export PGHOST="db.example.supabase.co"',
      'export PGPORT="5432"',
      'export PGUSER="cli_login_postgres"',
      'export PGPASSWORD="super-secret"',
      'export PGDATABASE="postgres"',
      'A new version of Supabase CLI is available'
    ].join('\n');

    expect(parseSupabaseDryRunConnection(sample)).toEqual({
      PGHOST: 'db.example.supabase.co',
      PGPORT: '5432',
      PGUSER: 'cli_login_postgres',
      PGPASSWORD: 'super-secret',
      PGDATABASE: 'postgres'
    });
  });
});
