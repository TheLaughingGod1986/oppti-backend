const {
  IMAGE_ALT_STATES,
  LEDGER_SYNC_SCOPES,
  countImageAltStatesForSite,
  getImageAltStateLedgerCoverage,
  markImageAltStateApproved,
  syncImageAltStates,
  upsertGeneratedImageAltState
} = require('../../services/imageAltState');

function createImageAltStateSupabaseMock() {
  const state = {
    imageAltStates: []
  };

  function matchFilters(rows, filters) {
    return rows.filter((row) => filters.every(({ type, column, value }) => {
      if (type === 'eq') return row[column] === value;
      if (type === 'in') return Array.isArray(value) && value.includes(row[column]);
      return true;
    }));
  }

  function buildSelectChain(rows) {
    const filters = [];
    let countMode = false;

    const chain = {
      select(_columns, options = {}) {
        countMode = Boolean(options?.head && options?.count === 'exact');
        return chain;
      },
      eq(column, value) {
        filters.push({ type: 'eq', column, value });
        return chain;
      },
      in(column, value) {
        filters.push({ type: 'in', column, value });
        return chain;
      },
      maybeSingle: async () => {
        const results = matchFilters(rows, filters);
        return { data: results[0] || null, error: null };
      },
      then(resolve, reject) {
        const results = matchFilters(rows, filters);
        const payload = countMode
          ? { count: results.length, error: null }
          : { data: results, error: null };
        return Promise.resolve(payload).then(resolve, reject);
      }
    };

    return chain;
  }

  return {
    _state: state,
    from(table) {
      if (table !== 'image_alt_states') {
        throw new Error(`Unexpected table ${table}`);
      }

      return {
        select(columns, options) {
          return buildSelectChain(state.imageAltStates).select(columns, options);
        },
        upsert(payload) {
          const rows = Array.isArray(payload) ? payload : [payload];
          const applied = rows.map((row) => {
            const existing = state.imageAltStates.find((entry) => entry.site_id === row.site_id && entry.image_ref === row.image_ref);
            if (existing) {
              Object.assign(existing, row);
              return { ...existing };
            }

            const inserted = {
              id: `image_state_${state.imageAltStates.length + 1}`,
              created_at: new Date().toISOString(),
              ...row
            };
            state.imageAltStates.push(inserted);
            return { ...inserted };
          });

          if (Array.isArray(payload)) {
            return Promise.resolve({ data: applied, error: null });
          }

          const inserted = applied[0];
          return {
            select() {
              return {
                maybeSingle: async () => ({ data: inserted, error: null })
              };
            }
          };
        }
      };
    }
  };
}

describe('image alt state ledger', () => {
  test('generation creates a NEEDS_REVIEW row for the image', async () => {
    const supabase = createImageAltStateSupabaseMock();

    const result = await upsertGeneratedImageAltState(supabase, {
      siteId: 'site_1',
      image: {
        attachment_id: 123,
        url: 'https://example.com/image.jpg'
      },
      context: {
        pageTitle: 'Gallery'
      },
      altText: 'Generated alt text',
      generationRequestId: 'generation_request_1'
    });

    expect(result.error).toBeNull();
    expect(supabase._state.imageAltStates).toHaveLength(1);
    expect(supabase._state.imageAltStates[0]).toEqual(expect.objectContaining({
      site_id: 'site_1',
      attachment_id: '123',
      image_ref: 'attachment:123',
      current_state: IMAGE_ALT_STATES.NEEDS_REVIEW,
      alt_text: 'Generated alt text'
    }));
    expect(supabase._state.imageAltStates[0].last_generated_at).toBeTruthy();
  });

  test('approve updates the same image row to APPROVED', async () => {
    const supabase = createImageAltStateSupabaseMock();

    await upsertGeneratedImageAltState(supabase, {
      siteId: 'site_1',
      image: {
        attachment_id: 123,
        url: 'https://example.com/image.jpg'
      },
      altText: 'Generated alt text'
    });

    const result = await markImageAltStateApproved(supabase, {
      siteId: 'site_1',
      body: {
        attachment_id: 123
      },
      altText: 'Approved alt text'
    });

    expect(result.error).toBeNull();
    expect(supabase._state.imageAltStates).toHaveLength(1);
    expect(supabase._state.imageAltStates[0]).toEqual(expect.objectContaining({
      site_id: 'site_1',
      image_ref: 'attachment:123',
      current_state: IMAGE_ALT_STATES.APPROVED,
      alt_text: 'Approved alt text'
    }));
    expect(supabase._state.imageAltStates[0].last_reviewed_at).toBeTruthy();
  });

  test('dashboard counts are derived from persisted image state rows', async () => {
    const supabase = createImageAltStateSupabaseMock();

    const result = await syncImageAltStates(supabase, {
      siteId: 'site_1',
      images: [
        { attachment_id: 1, current_state: 'MISSING' },
        { attachment_id: 2, current_state: 'GENERATED', alt_text: 'Generated' },
        { attachment_id: 3, current_state: 'NEEDS_REVIEW', alt_text: 'Review me' },
        { attachment_id: 4, current_state: 'APPROVED', alt_text: 'Approved' }
      ]
    });

    expect(result).toEqual(expect.objectContaining({
      inserted: 4,
      updated: 0,
      unchanged: 0,
      missing_rows_created: 1,
      duplicate_input_rows: 0,
      coverage: expect.objectContaining({
        status: 'AUTHORITATIVE_LEDGER',
        snapshot_fallback_active: false,
        ledger_row_count: 4
      }),
      dashboard_counts: {
        missing: 1,
        to_review: 2,
        optimized: 1,
        total_attention: 3
      }
    }));

    const counts = await countImageAltStatesForSite(supabase, 'site_1');

    expect(counts).toEqual({
      available: true,
      source: 'image_alt_states',
      total_rows: 4,
      missing: 1,
      generated: 1,
      needs_review: 1,
      approved: 1
    });
  });

  test('sync is idempotent and reports unchanged rows on rerun', async () => {
    const supabase = createImageAltStateSupabaseMock();
    const images = [
      { attachment_id: 1, current_state: 'MISSING' },
      { attachment_id: 2, current_state: 'NEEDS_REVIEW', alt_text: 'Review me' },
      { attachment_id: 3, current_state: 'APPROVED', alt_text: 'Approved' }
    ];

    const first = await syncImageAltStates(supabase, {
      siteId: 'site_1',
      images
    });
    const second = await syncImageAltStates(supabase, {
      siteId: 'site_1',
      images
    });

    expect(first.inserted).toBe(3);
    expect(second).toEqual(expect.objectContaining({
      inserted: 0,
      updated: 0,
      unchanged: 3,
      duplicate_input_rows: 0,
      orphaned_existing_rows: 0
    }));
    expect(supabase._state.imageAltStates).toHaveLength(3);
  });

  test('sync does not downgrade an approved row to missing unless explicitly forced', async () => {
    const supabase = createImageAltStateSupabaseMock();

    await syncImageAltStates(supabase, {
      siteId: 'site_1',
      images: [
        { attachment_id: 55, current_state: 'APPROVED', alt_text: 'Approved alt' }
      ]
    });

    const preserved = await syncImageAltStates(supabase, {
      siteId: 'site_1',
      images: [
        { attachment_id: 55, current_state: 'MISSING' }
      ]
    });

    expect(preserved).toEqual(expect.objectContaining({
      inserted: 0,
      updated: 0,
      unchanged: 1
    }));
    expect(supabase._state.imageAltStates[0]).toEqual(expect.objectContaining({
      image_ref: 'attachment:55',
      current_state: 'APPROVED',
      alt_text: 'Approved alt'
    }));

    const forced = await syncImageAltStates(supabase, {
      siteId: 'site_1',
      images: [
        { attachment_id: 55, current_state: 'MISSING', force_state: true }
      ],
      allowDowngrade: false
    });

    expect(forced.updated).toBe(1);
    expect(supabase._state.imageAltStates[0]).toEqual(expect.objectContaining({
      image_ref: 'attachment:55',
      current_state: 'MISSING',
      alt_text: null
    }));
  });

  test('ledger coverage reports zero rows until sync, then switches off snapshot fallback', async () => {
    const supabase = createImageAltStateSupabaseMock();

    const before = await getImageAltStateLedgerCoverage(supabase, 'site_1', {
      scope: LEDGER_SYNC_SCOPES.FULL_SITE,
      inputImageCount: 2
    });

    expect(before).toEqual(expect.objectContaining({
      site_id: 'site_1',
      status: 'ZERO_ROWS',
      snapshot_fallback_active: true,
      ledger_row_count: 0
    }));

    await syncImageAltStates(supabase, {
      siteId: 'site_1',
      images: [
        { attachment_id: 1 },
        { attachment_id: 2, current_state: 'APPROVED', alt_text: 'Ready' }
      ]
    });

    const after = await getImageAltStateLedgerCoverage(supabase, 'site_1', {
      scope: LEDGER_SYNC_SCOPES.FULL_SITE,
      inputImageCount: 2
    });

    expect(after).toEqual(expect.objectContaining({
      site_id: 'site_1',
      status: 'AUTHORITATIVE_LEDGER',
      snapshot_fallback_active: false,
      ledger_row_count: 2,
      dashboard_counts: {
        missing: 1,
        to_review: 0,
        optimized: 1,
        total_attention: 1
      }
    }));
  });

  test('sync accepts the normal bulk job item id as a fallback image identity', async () => {
    const supabase = createImageAltStateSupabaseMock();

    const result = await syncImageAltStates(supabase, {
      siteId: 'site_1',
      images: [
        {
          id: 'bulk-item-42',
          image: {}
        }
      ]
    });

    expect(result).toEqual(expect.objectContaining({
      inserted: 1,
      updated: 0,
      unchanged: 0
    }));
    expect(supabase._state.imageAltStates[0]).toEqual(expect.objectContaining({
      image_ref: 'image:bulk-item-42',
      current_state: 'MISSING'
    }));
  });
});
