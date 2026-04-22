const { buildMissing, parseSupabaseDryRunConnection } = require('../../scripts/verify-site-quota-v2-schema');

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

  it('does not fail required verification when only deprecated merge compatibility objects are absent', () => {
    const summary = {
      tables: {
        plans: true,
        site_memberships: true,
        site_subscriptions: true,
        site_quotas: true,
        site_trials: true,
        generation_requests: true,
        usage_events: true,
        site_audit_logs: true
      },
      functions: {
        bbai_reserve_site_generation: { present: true, identity_matches: true, return_type_matches: true },
        bbai_finalize_site_generation: { present: true, identity_matches: true, return_type_matches: true },
        bbai_apply_site_billing_event: { present: true, identity_matches: true, return_type_matches: true }
      },
      deprecated_tables: {
        site_merges: false
      },
      deprecated_functions: {
        bbai_merge_sites: { present: false, identity_matches: false, return_type_matches: false }
      },
      trial_usage_columns: {
        anon_id: { present: true },
        anonymous_risk_key: { present: true },
        ip_hash: { present: true }
      },
      site_v2_columns: {
        normalized_site_url: { present: true },
        canonical_domain: { present: true },
        site_fingerprint: { present: true },
        wp_install_uuid: { present: true },
        owner_user_id: { present: true },
        first_seen_at: { present: true },
        last_seen_at: { present: true },
        merged_into_site_id: { present: true },
        environment: { present: true }
      },
      trigger: { present: true },
      site_trials_total_trial_credits_default_matches: true
    };

    expect(buildMissing(summary)).toEqual({
      tables: [],
      functions: [],
      trial_usage_columns: [],
      site_v2_columns: [],
      triggers: [],
      site_trials_defaults: []
    });
  });
});
