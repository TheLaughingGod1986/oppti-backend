/**
 * Integration coverage for the backward-compatible identity cleanup.
 *
 * Scenarios:
 *  1. Anonymous trial generation -> usage_logs license_id/user_id stay NULL.
 *  2. Signup/login site linking   -> sites.license_id is set.
 *  3. Generation after signup     -> usage_logs.license_id set, user_id NULL.
 *  4. Quota enforcement untouched -> quota/reservation code never references
 *     is_internal and the migration never touches quota tables.
 *
 * Plus migration-safety assertions (idempotent, FK-safe, additive) and that
 * the supabase linked-project replay matches the canonical migration.
 */

jest.mock('../../lib/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  getRecentEntries: jest.fn().mockReturnValue([]),
  clearRecentEntries: jest.fn()
}));

jest.mock('../../../src/services/loops', () => ({
  trackGenerationMilestone: jest.fn().mockResolvedValue(undefined),
  trackCreditsExhausted: jest.fn().mockResolvedValue(undefined),
  trackAccountCreated: jest.fn().mockResolvedValue(undefined),
  trackPlanUpgraded: jest.fn().mockResolvedValue(undefined)
}));

const fs = require('fs');
const path = require('path');
const { recordUsage } = require('../../services/usage');
const { syncLegacySitePointers } = require('../../services/siteQuota');

const REPO_ROOT = path.join(__dirname, '..', '..', '..');
const ACCOUNT_ID = '33333333-3333-4333-8333-333333333333';

function read(relPath) {
  return fs.readFileSync(path.join(REPO_ROOT, relPath), 'utf8');
}

function createUsageMock({ licenseId = null } = {}) {
  const captured = {};
  const supabase = {
    from(table) {
      if (table === 'licenses') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () =>
                Promise.resolve({ data: licenseId ? { id: licenseId } : null, error: null }),
              single: () => Promise.resolve({ data: null, error: null })
            })
          })
        };
      }
      if (table === 'usage_logs') {
        return {
          insert: (payload) => {
            captured.payload = payload;
            return { select: () => Promise.resolve({ data: [{ id: 'u1' }], error: null }) };
          },
          select: () => ({ eq: () => ({ gte: () => Promise.resolve({ data: [], error: null }) }) })
        };
      }
      return { insert: () => ({ select: () => Promise.resolve({ data: [], error: null }) }) };
    }
  };
  return { supabase, captured };
}

function createSyncMock() {
  const captured = {};
  const supabase = {
    from() {
      return {
        update: (payload) => {
          captured.sitesUpdate = captured.sitesUpdate || payload;
          return { eq: () => Promise.resolve({ data: null, error: null }) };
        }
      };
    }
  };
  return { supabase, captured };
}

describe('identity cleanup - flow behaviour', () => {
  test('1. anonymous trial generation keeps license_id and user_id NULL', async () => {
    const { supabase, captured } = createUsageMock({ licenseId: null });

    await recordUsage(supabase, {
      licenseKey: null,
      licenseId: null,
      userId: null,
      siteHash: 'anon-trial-hash',
      siteUrl: 'https://anonymous-trial-site.com',
      isTrial: true,
      authState: 'guest_trial',
      creditsUsed: 1
    });

    expect(captured.payload.license_id).toBeNull();
    expect(captured.payload.user_id).toBeNull();
    expect(captured.payload.is_trial).toBe(true);
  });

  test('2. signup/login site linking sets sites.license_id', async () => {
    const { supabase, captured } = createSyncMock();

    await syncLegacySitePointers(supabase, {
      site: { id: 'site-1', site_hash: 'known-hash', license_key: null, owner_user_id: null },
      account: { id: ACCOUNT_ID, license_key: 'acct-key' }
    });

    expect(captured.sitesUpdate.license_id).toBe(ACCOUNT_ID);
    expect(captured.sitesUpdate.license_key).toBe('acct-key');
  });

  test('3. generation after signup writes license_id and NULL user_id', async () => {
    const { supabase, captured } = createUsageMock({ licenseId: ACCOUNT_ID });

    // altText.js now passes userId: null and licenseId: licenseId||attribution
    await recordUsage(supabase, {
      licenseKey: 'acct-key',
      licenseId: ACCOUNT_ID,
      userId: null,
      siteHash: 'known-hash',
      siteUrl: 'https://realcustomer.com',
      authState: 'authenticated_free',
      creditsUsed: 1
    });

    expect(captured.payload.license_id).toBe(ACCOUNT_ID);
    expect(captured.payload.user_id).toBeNull();
    expect(captured.payload.is_internal).toBe(false);
  });

  test('4. quota/reservation code never references is_internal', () => {
    const quota = read('fresh-stack/services/quota.js');
    const siteQuota = read('fresh-stack/services/siteQuota.js');
    expect(quota).not.toMatch(/is_internal/);
    // siteQuota only gains license_id on the sites pointer sync, not quota logic
    expect(siteQuota).not.toMatch(/is_internal/);
  });
});

describe('identity cleanup - migration safety', () => {
  const canonical = read('fresh-stack/migrations/015_identity_cleanup_backfill.sql');
  const replay = read('supabase/migrations/20260519113206_identity_cleanup_backfill.sql');

  test('backfill only fills NULL license_id (idempotent, no overwrite)', () => {
    expect(canonical).toMatch(/UPDATE public\.usage_logs ul[\s\S]*WHERE ul\.license_id IS NULL/);
    expect(canonical).toMatch(/UPDATE public\.sites s[\s\S]*WHERE s\.license_id IS NULL/);
  });

  test('user_id backfill is FK-safe (only real licenses.id)', () => {
    expect(canonical).toMatch(/AND l\.id = ul\.user_id/);
  });

  test('is_internal column is additive and defaulted', () => {
    expect(canonical).toMatch(/ADD COLUMN IF NOT EXISTS is_internal boolean NOT NULL DEFAULT false/);
  });

  test('no destructive operations (executable SQL only, comments stripped)', () => {
    const executableSql = canonical
      .split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n');
    expect(executableSql).not.toMatch(/\bDROP\s+(COLUMN|TABLE)\b/i);
    expect(executableSql).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(executableSql).not.toMatch(/\bRENAME\b/i);
    expect(executableSql).not.toMatch(/\bTRUNCATE\b/i);
  });

  test('migration documents the production backup prerequisite', () => {
    expect(canonical).toMatch(/backup BEFORE applying/i);
  });

  test('supabase replay matches the canonical migration body', () => {
    const stripHeader = (s) => s.slice(s.indexOf('SET lock_timeout'));
    expect(stripHeader(replay)).toBe(stripHeader(canonical));
  });
});
