const {
  runImageAltStateSyncCli
} = require('../../scripts/sync-image-alt-states');

function createAsyncStdin(value) {
  return {
    isTTY: false,
    async *[Symbol.asyncIterator]() {
      yield value;
    }
  };
}

describe('image alt state ledger sync CLI', () => {
  test('prints sync summary and coverage using the shared sync service', async () => {
    const stdoutChunks = [];
    const stderrChunks = [];
    const exit = jest.fn();
    const fakeSupabase = { tag: 'supabase' };
    const siteResolver = jest.fn().mockResolvedValue({
      site: {
        id: 'site_1',
        site_hash: 'site-hash-1',
        site_url: 'https://example.com'
      },
      matchedBy: 'site_hash',
      error: null
    });
    const coverageResolver = jest.fn()
      .mockResolvedValueOnce({
        site_id: 'site_1',
        status: 'ZERO_ROWS',
        snapshot_fallback_active: true,
        ledger_row_count: 0
      });
    const syncRunner = jest.fn().mockResolvedValue({
      count: 3,
      inserted: 3,
      updated: 0,
      unchanged: 0,
      missing_rows_created: 2,
      duplicate_input_rows: 0,
      orphaned_existing_rows: 0,
      errors: [],
      coverage: {
        status: 'AUTHORITATIVE_LEDGER',
        snapshot_fallback_active: false,
        ledger_row_count: 3,
        state_counts: {
          missing: 2,
          generated: 0,
          needs_review: 0,
          approved: 1
        },
        dashboard_counts: {
          missing: 2,
          to_review: 0,
          optimized: 1,
          total_attention: 2
        }
      }
    });

    const result = await runImageAltStateSyncCli({
      argv: ['--site-hash', 'site-hash-1', '--pretty'],
      env: {
        SUPABASE_URL: 'https://example.supabase.co',
        SUPABASE_SERVICE_ROLE_KEY: 'service-role-key'
      },
      stdin: createAsyncStdin(JSON.stringify({
        images: [
          { attachment_id: 1 },
          { attachment_id: 2 },
          { attachment_id: 3, current_state: 'APPROVED', alt_text: 'Approved alt' }
        ]
      })),
      stdout: {
        write: (chunk) => stdoutChunks.push(chunk)
      },
      stderr: {
        write: (chunk) => stderrChunks.push(chunk)
      },
      supabase: fakeSupabase,
      siteResolver,
      coverageResolver,
      syncRunner,
      exit
    });

    expect(result).toEqual(expect.objectContaining({
      success: true,
      site: expect.objectContaining({
        site_id: 'site_1',
        site_hash: 'site-hash-1'
      }),
      sync: expect.objectContaining({
        inserted: 3,
        updated: 0,
        unchanged: 0,
        missing_rows_created: 2
      }),
      after: expect.objectContaining({
        status: 'AUTHORITATIVE_LEDGER',
        snapshot_fallback_active: false
      })
    }));
    expect(stderrChunks).toHaveLength(0);
    expect(exit).not.toHaveBeenCalled();
    expect(siteResolver).toHaveBeenCalledWith(fakeSupabase, expect.objectContaining({
      siteHash: 'site-hash-1'
    }));
    expect(syncRunner).toHaveBeenCalledWith(fakeSupabase, expect.objectContaining({
      siteId: 'site_1',
      siteHash: 'site-hash-1',
      images: expect.any(Array),
      scope: 'full_site'
    }));

    const parsedOutput = JSON.parse(stdoutChunks.join(''));
    expect(parsedOutput).toEqual(expect.objectContaining({
      site: expect.any(Object),
      input: expect.any(Object),
      before: expect.any(Object),
      sync: expect.any(Object),
      after: expect.any(Object)
    }));
  });
});
