jest.mock('../../lib/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  getRecentEntries: jest.fn().mockReturnValue([]),
  clearRecentEntries: jest.fn()
}));

const logger = require('../../lib/logger');
const { createGuestRowsTables } = require('../helpers/guestRowsMock');
const { linkGuestTrialRowsOnSignup, isGuestTrialLinkEnabled, AUDIT_EVENT } = require('../../services/guestTrialLink');

const ACCOUNT = { id: 'acct-new', license_key: 'lic-new', created_at: '2026-10-26T09:00:00.000Z' };
const SITE = { id: 'site-a', site_hash: 'hash-a', license_key: null };

function guestUsage(id, extra = {}) {
  return {
    id, site_hash: 'hash-a', is_trial: true, auth_state: 'guest_trial', license_id: null, user_id: null,
    credits_used: 1, created_at: '2026-10-26T08:55:00.000Z', ...extra
  };
}
function guestRequest(id, extra = {}) {
  return { id, site_id: 'site-a', quota_source: 'trial', user_id: null, created_at: '2026-10-26T08:55:00.000Z', ...extra };
}

function createSupabase(seed) {
  const rows = createGuestRowsTables(seed);
  const audits = [];
  return {
    rows,
    audits,
    from(table) {
      if (rows.handles(table)) return rows.from(table);
      if (table === 'site_audit_logs') {
        return { insert(payload) { audits.push(payload); return Promise.resolve({ data: payload, error: null }); } };
      }
      throw new Error(`Unexpected table: ${table}`);
    }
  };
}

function seed() {
  return {
    usageLogs: [
      guestUsage('u1'),
      guestUsage('u2'),
      guestUsage('u-other-site', { site_hash: 'hash-b' }),
      guestUsage('u-owned', { license_id: 'acct-old' }),
      guestUsage('u-paid', { is_trial: false, auth_state: 'authenticated_free' }),
      guestUsage('u-after', { created_at: '2026-10-26T09:05:00.000Z' })
    ],
    generationRequests: [
      guestRequest('g1'),
      guestRequest('g-other-site', { site_id: 'site-b' }),
      guestRequest('g-quota', { quota_source: 'site_quota' }),
      guestRequest('g-owned', { user_id: 'acct-old' })
    ]
  };
}

beforeEach(() => {
  logger.info.mockClear();
  logger.warn.mockClear();
});

describe('isGuestTrialLinkEnabled', () => {
  test('defaults off', () => {
    expect(isGuestTrialLinkEnabled({})).toBe(false);
    expect(isGuestTrialLinkEnabled({ LINK_GUEST_TRIAL_ON_SIGNUP: 'false' })).toBe(false);
    expect(isGuestTrialLinkEnabled({ LINK_GUEST_TRIAL_ON_SIGNUP: 'true' })).toBe(true);
    expect(isGuestTrialLinkEnabled({ LINK_GUEST_TRIAL_ON_SIGNUP: '1' })).toBe(true);
  });
});

describe('linkGuestTrialRowsOnSignup', () => {
  test('when off, writes nothing and logs would-link counts only', async () => {
    const supabase = createSupabase(seed());
    const result = await linkGuestTrialRowsOnSignup({ supabase, account: ACCOUNT, site: SITE, enabled: false });

    expect(result).toEqual(expect.objectContaining({ mode: 'dry_run', usage_logs: 2, generation_requests: 1 }));
    expect(supabase.rows.updates).toHaveLength(0);
    expect(supabase.audits).toHaveLength(0);
    const line = logger.info.mock.calls.find(([message]) => message === '[Auth] guest_trial_link');
    expect(line[1]).toEqual(expect.objectContaining({ mode: 'dry_run', would_link_usage_logs: 2, would_link_generation_requests: 1 }));
    expect(JSON.stringify(line[1])).not.toContain('lic-new');
  });

  test("when on, links only this site's NULL guest rows from before sign-up and records their ids", async () => {
    const supabase = createSupabase(seed());
    const result = await linkGuestTrialRowsOnSignup({ supabase, account: ACCOUNT, site: SITE, enabled: true, requestId: 'req-1' });

    expect(result.usage_log_ids.sort()).toEqual(['u1', 'u2']);
    expect(result.generation_request_ids).toEqual(['g1']);
    const usage = Object.fromEntries(supabase.rows.tables.usage_logs.map((row) => [row.id, row]));
    expect(usage.u1.license_id).toBe('acct-new');
    expect(usage.u2.license_id).toBe('acct-new');
    expect(usage['u-other-site'].license_id).toBeNull();
    expect(usage['u-owned'].license_id).toBe('acct-old');
    expect(usage['u-paid'].license_id).toBeNull();
    expect(usage['u-after'].license_id).toBeNull();
    const requests = Object.fromEntries(supabase.rows.tables.generation_requests.map((row) => [row.id, row]));
    expect(requests.g1.user_id).toBe('acct-new');
    expect(requests['g-other-site'].user_id).toBeNull();
    expect(requests['g-quota'].user_id).toBeNull();
    expect(requests['g-owned'].user_id).toBe('acct-old');

    expect(supabase.audits).toEqual([expect.objectContaining({
      site_id: 'site-a',
      actor_user_id: 'acct-new',
      event_type: AUDIT_EVENT,
      request_id: 'req-1',
      metadata: expect.objectContaining({ usage_log_ids: expect.arrayContaining(['u1', 'u2']), generation_request_ids: ['g1'] })
    })]);
    const line = logger.info.mock.calls.find(([message]) => message === '[Auth] guest_trial_link');
    expect(line[1]).toEqual(expect.objectContaining({ mode: 'applied', linked_usage_logs: 2, linked_generation_requests: 1 }));
  });

  test('linked rows stay trial rows, so they never count against the free allowance', async () => {
    const supabase = createSupabase(seed());
    await linkGuestTrialRowsOnSignup({ supabase, account: ACCOUNT, site: SITE, enabled: true });

    for (const update of supabase.rows.updates) {
      expect(Object.keys(update.payload)).toEqual([update.table === 'usage_logs' ? 'license_id' : 'user_id']);
    }
    const linked = supabase.rows.tables.usage_logs.filter((row) => row.license_id === 'acct-new');
    expect(linked.every((row) => row.is_trial === true && row.auth_state === 'guest_trial')).toBe(true);
    // Same predicate services/quota.js and services/siteQuota.js use for credit totals.
    const countedForCredits = supabase.rows.tables.usage_logs
      .filter((row) => row.site_hash === 'hash-a')
      .filter((row) => row.is_trial === null || row.is_trial === undefined || row.is_trial === false);
    expect(countedForCredits.map((row) => row.id)).toEqual(['u-paid']);
    const request = supabase.rows.tables.generation_requests.find((row) => row.id === 'g1');
    expect(request.quota_source).toBe('trial');
  });

  test('is idempotent: a second run links nothing and writes no audit', async () => {
    const supabase = createSupabase(seed());
    await linkGuestTrialRowsOnSignup({ supabase, account: ACCOUNT, site: SITE, enabled: true });
    const second = await linkGuestTrialRowsOnSignup({ supabase, account: ACCOUNT, site: SITE, enabled: true });

    expect(second.usage_logs).toBe(0);
    expect(second.generation_requests).toBe(0);
    expect(supabase.audits).toHaveLength(1);
  });

  test.each([
    ['a shared site', { site: SITE, sharedSite: true }],
    ['a site held by another licence', { site: { ...SITE, license_key: 'lic-other' } }],
    ['a site owned by another user', { site: { ...SITE, owner_user_id: 'acct-other' } }],
    ['no site', { site: null }]
  ])('never touches %s', async (_label, extra) => {
    const supabase = createSupabase(seed());
    const result = await linkGuestTrialRowsOnSignup({ supabase, account: ACCOUNT, enabled: true, ...extra });

    expect(result.skipped).toBe('site_not_owned_by_account');
    expect(supabase.rows.updates).toHaveLength(0);
    expect(supabase.audits).toHaveLength(0);
  });

  test('a database error is logged and never thrown', async () => {
    const supabase = {
      from() { throw new Error('boom'); }
    };
    const result = await linkGuestTrialRowsOnSignup({ supabase, account: ACCOUNT, site: SITE, enabled: true });

    expect(result.skipped).toBe('error');
    expect(logger.warn).toHaveBeenCalledWith('[Auth] guest_trial_link_failed', expect.objectContaining({ error: 'boom' }));
  });
});
